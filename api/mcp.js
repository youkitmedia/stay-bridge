// stay-bridge — 유킷 스튜디오 전용 MCP 브리지
// claude.ai 커스텀 커넥터로 등록해 아티팩트(스테이 소스 메이커)가
// Higgsfield API(영상)와 Fish Audio API(나레이션)를 쓰게 한다.
// API 키는 Vercel 환경변수에서만 읽고, 응답·로그에 절대 싣지 않는다.

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const HF_BASE = (process.env.HF_API_BASE_URL || "https://api.higgsfield.ai").replace(/\/$/, "");
const FISH_BASE = "https://api.fish.audio";
const SERVER_NAME = "stay-bridge";
const SERVER_VERSION = "0.2.0";

const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
const MAX_BATCH_USD = num(process.env.MAX_BATCH_USD, 10); // 한 번에 제출할 수 있는 영상 견적 상한
const MAX_CLIPS = num(process.env.MAX_CLIPS, 8); // 한 번에 제출할 수 있는 클립 수
const FISH_MODEL = process.env.FISH_MODEL || "s2.1-pro-free";

// 경로·요청 형식은 higgsfield-ai/app-templates(studio)의 모델 카탈로그 기준.
// price는 초당 달러, 콘솔 가격표의 "from"(최저 사양) 값. 실제 청구액은 콘솔에서 확인.
const DEFAULT_MODELS = {
  "kling-3-std": {
    label: "Kling 3.0 Standard",
    path: "kling-video/v3.0/std/image-to-video",
    kind: "kling",
    duration: [3, 15],
    price: 0.084,
  },
  "kling-3-pro": {
    label: "Kling 3.0 Pro",
    path: "kling-video/v3.0/pro/image-to-video",
    kind: "kling",
    duration: [3, 15],
    price: null,
  },
  "seedance-2": {
    label: "Seedance 2.0",
    path: "bytedance/seedance-2.0/image-to-video",
    kind: "seedance",
    duration: [4, 15],
    resolutions: ["480p", "720p", "1080p"],
    price: 0.141,
    r2v: { path: "bytedance/seedance-2.0/reference-to-video", maxRefs: 9 },
  },
  "seedance-2.5": {
    label: "Seedance 2.5",
    path: "bytedance/seedance-2.5/image-to-video",
    kind: "seedance",
    duration: [4, 30],
    resolutions: ["480p", "720p"],
    price: 0.206,
    r2v: { path: "bytedance/seedance-2.5/reference-to-video", maxRefs: 30 },
    bitrate: true,
  },
  "seedance-2-fast": {
    label: "Seedance 2.0 Fast",
    path: "bytedance/seedance-2.0/fast/image-to-video",
    kind: "seedance",
    duration: [4, 15],
    resolutions: ["480p", "720p"],
    price: null,
  },
};

function models() {
  const m = JSON.parse(JSON.stringify(DEFAULT_MODELS));
  // PRICES_JSON='{"kling-3-pro":0.11}' 처럼 콘솔에서 확인한 단가로 덮어쓰기
  try {
    const over = JSON.parse(process.env.PRICES_JSON || "{}");
    for (const [k, v] of Object.entries(over)) if (m[k] && Number.isFinite(Number(v))) m[k].price = Number(v);
  } catch {}
  return m;
}

/* ---------------- 공통 유틸 ---------------- */
class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg); };
const hfKey = () => process.env.HF_API_KEY || fail("서버에 HF_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.");
const fishKey = () => process.env.FISH_API_KEY || fail("서버에 FISH_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.");

async function readBody(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

function explainHttp(service, status, body) {
  const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
  if (status === 401 || status === 403) return `${service} 인증 실패(${status}). API 키가 올바른지 확인하세요.`;
  if (status === 402) return `${service} 잔액이 부족합니다(402). 콘솔에서 충전하세요.`;
  if (status === 429) return `${service} 요청 한도 초과(429). 잠시 후 다시 시도하세요.`;
  return `${service} 오류 ${status}: ${detail}`;
}

async function hf(method, path, body) {
  const r = await fetch(`${HF_BASE}/${path.replace(/^\//, "")}`, {
    method,
    headers: { Authorization: `Key ${hfKey()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await readBody(r);
  if (!r.ok) fail(explainHttp("Higgsfield", r.status, data));
  return data;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { error: e instanceof ToolError ? e.message : `처리 실패: ${String(e?.message || e).slice(0, 200)}` }; }
    }
  });
  await Promise.all(workers);
  return out;
}

function sniffType(buf, header) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  const h = String(header || "").split(";")[0].trim().toLowerCase();
  if (h === "image/jpg") return "image/jpeg";
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(h) ? h : null;
}

/* ---------------- 도구 구현 ---------------- */
async function bridgeInfo() {
  const m = models();
  return {
    server: `${SERVER_NAME} ${SERVER_VERSION}`,
    higgsfield_key: Boolean(process.env.HF_API_KEY),
    fish_key: Boolean(process.env.FISH_API_KEY),
    fish_model: FISH_MODEL,
    limits: { max_batch_usd: MAX_BATCH_USD, max_clips: MAX_CLIPS },
    models: Object.fromEntries(Object.entries(m).map(([id, v]) => [id, {
      label: v.label, duration: v.duration, resolutions: v.resolutions || null,
      price_per_second_min: v.price, film: Boolean(v.r2v), max_refs: v.r2v?.maxRefs || 0,
    }])),
    note: "price_per_second_min은 콘솔 가격표의 최저 사양 단가입니다. 실제 청구액은 해상도·모드에 따라 더 높을 수 있습니다.",
  };
}

function estimate({ model, duration, clips }) {
  const m = models()[model] || fail(`알 수 없는 모델: ${model}. 사용 가능: ${Object.keys(models()).join(", ")}`);
  const d = num(duration, 5), n = num(clips, 1);
  if (m.price == null) return { model, known: false, message: `${m.label} 단가가 등록되지 않았습니다. 콘솔 가격 확인 후 PRICES_JSON에 넣어 주세요.` };
  const usd = +(m.price * d * n).toFixed(3);
  return { model, known: true, per_clip_usd_min: +(m.price * d).toFixed(3), total_usd_min: usd, clips: n, duration: d };
}

async function uploadImages({ urls, referer }) {
  if (!Array.isArray(urls) || !urls.length) fail("urls 배열이 필요합니다.");
  if (urls.length > 12) fail("한 번에 12장까지 올릴 수 있습니다.");
  hfKey();
  const results = await pool(urls, 4, async (url) => {
    let u;
    try { u = new URL(String(url)); } catch { fail("올바른 URL이 아닙니다."); }
    if (u.protocol !== "https:" && u.protocol !== "http:") fail("http(s) 주소만 가져올 수 있습니다.");
    const r = await fetch(u.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Referer: referer || `${u.protocol}//${u.host}/`,
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!r.ok) fail(`원본 사진을 가져오지 못했습니다(${r.status}). 사이트가 외부 가져오기를 막았을 수 있습니다.`);
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 20 * 1024 * 1024) fail("사진이 20MB를 넘습니다.");
    const type = sniffType(buf, r.headers.get("content-type")) || fail("지원하지 않는 이미지 형식입니다(jpeg/png/webp/gif만 가능).");
    const ticket = await hf("POST", "files/generate-upload-url", { content_type: type });
    const put = await fetch(ticket.upload_url, { method: "PUT", headers: ticket.upload_headers || { "Content-Type": type }, body: buf });
    if (!put.ok) fail(`Higgsfield 저장소 업로드 실패(${put.status}).`);
    return { public_url: ticket.public_url, content_type: type, bytes: buf.byteLength };
  });
  return { results: results.map((r, i) => ({ source: urls[i], ...r })) };
}

function videoBody(m, clip, opts) {
  const prompt = String(clip.prompt || "").trim() || fail("prompt가 비어 있는 클립이 있습니다.");
  const image_url = String(clip.image_url || "").trim() || fail("image_url이 비어 있는 클립이 있습니다.");
  const [lo, hi] = m.duration;
  const duration = Math.round(num(opts.duration, 5));
  if (duration < lo || duration > hi) fail(`${m.label}의 길이는 ${lo}~${hi}초입니다.`);
  if (m.kind === "kling") {
    return { prompt, image_url, duration, sound: "off", cfg_scale: num(opts.cfg_scale, 0.5), multi_shots: false };
  }
  const resolution = opts.resolution || "720p";
  if (!m.resolutions.includes(resolution)) fail(`${m.label} 해상도는 ${m.resolutions.join("/")} 중 하나입니다.`);
  return { prompt, image_url, duration, resolution, generate_audio: false };
}

async function submitVideos({ model, duration, resolution, cfg_scale, clips, max_total_usd }) {
  const m = models()[model] || fail(`알 수 없는 모델: ${model}`);
  if (!Array.isArray(clips) || !clips.length) fail("clips 배열이 필요합니다.");
  if (clips.length > MAX_CLIPS) fail(`한 번에 ${MAX_CLIPS}개까지 제출할 수 있습니다.`);
  const bodies = clips.map((c) => videoBody(m, c, { duration, resolution, cfg_scale })); // 전부 검증한 뒤에만 제출
  const est = estimate({ model, duration, clips: clips.length });
  if (est.known) {
    if (est.total_usd_min > MAX_BATCH_USD) fail(`견적 $${est.total_usd_min}가 서버 상한 $${MAX_BATCH_USD}를 넘습니다.`);
    if (max_total_usd != null && est.total_usd_min > Number(max_total_usd)) fail(`견적 $${est.total_usd_min}가 승인한 한도 $${max_total_usd}를 넘어 제출하지 않았습니다.`);
  } else if (max_total_usd == null) {
    fail(`${m.label}은 단가가 등록되지 않아 자동 제출을 막았습니다. 단가를 등록하거나 max_total_usd를 명시하세요.`);
  }
  const results = await pool(bodies, 3, async (body) => {
    const q = await hf("POST", m.path, body);
    if (!q.request_id) fail("응답에 request_id가 없습니다.");
    return { request_id: q.request_id, status: q.status || "queued" };
  });
  return {
    model, estimate: est,
    results: results.map((r, i) => ({ key: clips[i].key ?? i, ...r })),
    note: "제출 실패한 클립만 다시 제출하세요. 성공한 request_id는 다시 제출하지 마세요.",
  };
}

const ASPECTS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
/* 참조 이미지 여러 장 + 컷표 프롬프트로 음악까지 포함한 한 편을 한 번에 생성 (비용 발생) */
async function submitFilm({ model, duration, resolution, aspect_ratio, prompt, image_urls, generate_audio, max_total_usd }) {
  const m = models()[model] || fail(`알 수 없는 모델: ${model}`);
  if (!m.r2v) fail(`${m.label}은 참조 이미지 영상(reference-to-video)을 지원하지 않습니다.`);
  const p = String(prompt || "").trim() || fail("prompt가 비어 있습니다.");
  if (p.length > 8000) fail("prompt가 너무 깁니다(8000자 이내).");
  const refs = (Array.isArray(image_urls) ? image_urls : []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!refs.length) fail("image_urls가 비어 있습니다.");
  if (refs.length > m.r2v.maxRefs) fail(`${m.label} 참조 이미지는 ${m.r2v.maxRefs}장까지입니다.`);
  const [lo, hi] = m.duration;
  const d = Math.round(num(duration, 20));
  if (d < lo || d > hi) fail(`${m.label}의 길이는 ${lo}~${hi}초입니다.`);
  const res = resolution || "720p";
  if (!m.resolutions.includes(res)) fail(`${m.label} 해상도는 ${m.resolutions.join("/")} 중 하나입니다.`);
  const ar = aspect_ratio || "16:9";
  if (!ASPECTS.includes(ar)) fail(`화면비는 ${ASPECTS.join(", ")} 중 하나입니다.`);
  const est = estimate({ model, duration: d, clips: 1 });
  if (est.known) {
    if (est.total_usd_min > MAX_BATCH_USD) fail(`견적 $${est.total_usd_min}가 서버 상한 $${MAX_BATCH_USD}를 넘습니다.`);
    if (max_total_usd != null && est.total_usd_min > Number(max_total_usd)) fail(`견적 $${est.total_usd_min}가 승인한 한도 $${max_total_usd}를 넘어 제출하지 않았습니다.`);
  } else if (max_total_usd == null) fail(`${m.label}은 단가가 등록되지 않아 자동 제출을 막았습니다.`);
  const body = { prompt: p, image_urls: refs, duration: d, resolution: res, aspect_ratio: ar, generate_audio: generate_audio !== false, ...(m.bitrate ? { bitrate_mode: "high" } : {}) };
  const q = await hf("POST", m.r2v.path, body);
  if (!q.request_id) fail("응답에 request_id가 없습니다.");
  return { model, estimate: est, request_id: q.request_id, status: q.status || "queued", note: "같은 영상을 다시 제출하지 마세요. video_status로 결과를 확인하세요." };
}

/* ---------------- 최종본: 영상 음악 위에 마지막 내레이션을 얹고 -14 LUFS로 맞춘다 ---------------- */
function run(bin, args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (c) => { err += c; if (err.length > 200000) err = err.slice(-100000); });
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, err }); });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, err: String(e) }); });
  });
}
const durOf = (err) => { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };
async function fetchTo(url, file, max) {
  let u; try { u = new URL(String(url)); } catch { fail("video_url이 올바르지 않습니다."); }
  if (u.protocol !== "https:") fail("https 주소만 받을 수 있습니다.");
  const r = await fetch(u.href);
  if (!r.ok) fail(`영상을 내려받지 못했습니다(${r.status}).`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > max) fail("영상이 너무 큽니다.");
  await fsp.writeFile(file, buf);
  return buf.length;
}
async function finalizeVideo({ video_url, narration_base64, narration_start, end_pad, duck, lufs }) {
  hfKey();
  if (!ffmpegPath) fail("서버에 ffmpeg가 없습니다.");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fin-"));
  try {
    const vin = path.join(dir, "in.mp4"), nin = path.join(dir, "n.mp3"), out = path.join(dir, "out.mp4");
    await fetchTo(video_url, vin, 300 * 1024 * 1024);
    const probe = await run(ffmpegPath, ["-hide_banner", "-i", vin]);
    const vdur = durOf(probe.err) || fail("영상 길이를 읽지 못했습니다.");
    const hasAudio = /Stream #\S+.*Audio:/.test(probe.err);
    let ndur = 0, start = 0;
    const narr = String(narration_base64 || "");
    if (narr) {
      const nb = Buffer.from(narr, "base64");
      if (nb.length < 100) fail("내레이션 오디오가 비어 있습니다.");
      if (nb.length > 5 * 1024 * 1024) fail("내레이션 오디오가 너무 큽니다.");
      await fsp.writeFile(nin, nb);
      ndur = durOf((await run(ffmpegPath, ["-hide_banner", "-i", nin])).err) || fail("내레이션 길이를 읽지 못했습니다.");
      if (ndur > vdur - 0.5) fail(`내레이션(${ndur.toFixed(1)}초)이 영상(${vdur.toFixed(1)}초)보다 깁니다.`);
      const pad = Math.min(3, Math.max(0, num(end_pad, 0.6)));
      start = narration_start != null ? Math.max(0, Math.min(num(narration_start, 0), vdur - ndur)) : Math.max(0, vdur - ndur - pad);
    }
    const target = Math.min(-9, Math.max(-24, num(lufs, -14)));
    const keep = Math.min(1, Math.max(0.1, num(duck, 0.4))); // 내레이션 동안 음악을 이 비율로 낮춤
    const mix = path.join(dir, "mix.wav");
    const args = ["-hide_banner", "-y", "-i", vin];
    let fc;
    const music = hasAudio ? "[0:a]aresample=48000,aformat=channel_layouts=stereo" : `anullsrc=r=48000:cl=stereo,atrim=0:${vdur.toFixed(3)}`;
    if (narr) {
      args.push("-i", nin);
      const ds = Math.max(0, start - 0.4).toFixed(3), ms = Math.round(start * 1000);
      // 음악은 그대로 두고 내레이션 0.4초 전부터 keep 비율로 낮춘다. 내레이션은 음악보다 또렷하게 미리 맞춘다.
      fc = `${music},volume=eval=frame:volume='1-${(1 - keep).toFixed(3)}*clip((t-${ds})/0.4,0,1)'[m];` +
        `[1:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=${target + 1}:TP=-2:LRA=7,adelay=${ms}|${ms}[n];` +
        `[m][n]amix=inputs=2:normalize=0:duration=first[a]`;
    } else {
      fc = `${music}[a]`;
    }
    args.push("-filter_complex", fc, "-map", "[a]", "-t", vdur.toFixed(3), "-c:a", "pcm_s16le", mix);
    let r = await run(ffmpegPath, args, 30000);
    if (r.code !== 0) fail("소리 합성 실패: " + r.err.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 300));
    // 2패스 음량 정규화: 측정 → 선형 보정 (-14 LUFS, 최고치 -1 dBTP)
    const ln = `loudnorm=I=${target}:TP=-1:LRA=11`;
    const meas = await run(ffmpegPath, ["-hide_banner", "-i", mix, "-af", `${ln}:print_format=json`, "-f", "null", "-"], 20000);
    let M = null; try { M = JSON.parse(meas.err.slice(meas.err.lastIndexOf("{"), meas.err.lastIndexOf("}") + 1)); } catch {}
    const silent = !M || !Number.isFinite(Number(M.input_i)) || Number(M.input_i) < -60;
    const af = silent ? "anull" : `${ln}:measured_I=${M.input_i}:measured_TP=${M.input_tp}:measured_LRA=${M.input_lra}:measured_thresh=${M.input_thresh}:offset=${M.target_offset}:linear=true,aresample=48000`;
    r = await run(ffmpegPath, ["-hide_banner", "-y", "-i", vin, "-i", mix, "-map", "0:v:0", "-map", "1:a", "-af", af, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", vdur.toFixed(3), "-movflags", "+faststart", out], 40000);
    if (r.code !== 0) fail("최종본 합성 실패: " + r.err.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 300));
    const buf = await fsp.readFile(out);
    const ticket = await hf("POST", "files/generate-upload-url", { content_type: "video/mp4" });
    const put = await fetch(ticket.upload_url, { method: "PUT", headers: ticket.upload_headers || { "Content-Type": "video/mp4" }, body: buf });
    if (!put.ok) fail(`최종본 업로드 실패(${put.status}).`);
    return { final_url: ticket.public_url, bytes: buf.length, video_seconds: +vdur.toFixed(2), had_audio: hasAudio,
      narration_start: narr ? +start.toFixed(2) : null, narration_seconds: narr ? +ndur.toFixed(2) : null, lufs: target };
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function statusOf({ request_ids }) {
  if (!Array.isArray(request_ids) || !request_ids.length) fail("request_ids 배열이 필요합니다.");
  if (request_ids.length > 12) fail("한 번에 12개까지 조회할 수 있습니다.");
  const results = await pool(request_ids, 6, async (id) => {
    const s = await hf("GET", `requests/${encodeURIComponent(String(id))}/status`);
    return {
      status: s.status,
      video_url: s.video?.url || null,
      image_urls: Array.isArray(s.images) ? s.images.map((x) => x?.url).filter(Boolean) : [],
      error: s.error || null,
    };
  });
  const terminal = new Set(["completed", "failed", "nsfw", "canceled"]);
  const list = results.map((r, i) => ({ request_id: request_ids[i], ...r }));
  return { all_terminal: list.every((r) => terminal.has(r.status) || r.error), results: list };
}

async function cancel({ request_id }) {
  if (!request_id) fail("request_id가 필요합니다.");
  await hf("POST", `requests/${encodeURIComponent(String(request_id))}/cancel`, {});
  return { request_id, canceled: true };
}

async function fishTts({ text, reference_id, speed, bitrate }) {
  const t = String(text || "").trim() || fail("text가 비어 있습니다.");
  if (t.length > 500) fail("한 번에 500자까지 변환할 수 있습니다. 줄 단위로 나눠 주세요.");
  const body = {
    text: t,
    format: "mp3",
    mp3_bitrate: [64, 128, 192].includes(Number(bitrate)) ? Number(bitrate) : 128,
    latency: "normal",
    normalize: false,
    ...(reference_id ? { reference_id: String(reference_id) } : {}),
    ...(speed ? { prosody: { speed: Math.min(2, Math.max(0.5, num(speed, 1))) } } : {}),
  };
  const r = await fetch(`${FISH_BASE}/v1/tts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fishKey()}`, "Content-Type": "application/json", model: FISH_MODEL },
    body: JSON.stringify(body),
  });
  if (!r.ok) fail(explainHttp("Fish Audio", r.status, await readBody(r)));
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) fail("Fish Audio가 빈 오디오를 돌려줬습니다.");
  const bytes = Buffer.byteLength(t, "utf8");
  return {
    model: FISH_MODEL,
    mime: "audio/mpeg",
    audio_base64: buf.toString("base64"),
    audio_bytes: buf.length,
    billed_text_bytes: bytes,
    est_cost_usd: FISH_MODEL === "s2.1-pro-free" ? 0 : +((bytes / 1e6) * 15).toFixed(5),
  };
}

async function fishVoices({ query, language, licensed, page_size, self }) {
  const p = new URLSearchParams();
  p.set("page_size", String(Math.min(50, Math.max(1, num(page_size, 20)))));
  p.set("sort_by", "score");
  if (self) p.set("self", "true");
  else {
    p.set("language", language || "ko");
    if (licensed !== false) p.set("licensed", "true");
  }
  if (query) p.set("title", String(query));
  const r = await fetch(`${FISH_BASE}/model?${p}`, { headers: { Authorization: `Bearer ${fishKey()}` } });
  const data = await readBody(r);
  if (!r.ok) fail(explainHttp("Fish Audio", r.status, data));
  return {
    total: data.total,
    voices: (data.items || []).map((v) => ({
      reference_id: v._id, title: v.title, description: String(v.description || "").slice(0, 120),
      languages: v.languages, licensed: Boolean(v.licensed), tags: (v.tags || []).slice(0, 6),
      uses: v.task_count, sample_url: v.samples?.[0]?.audio || null,
    })),
    note: licensed !== false && !self ? "licensed=true: Fish Audio가 라이선스를 확보한 목소리만 표시합니다." : undefined,
  };
}

/* ---------------- MCP 도구 정의 ---------------- */
const TOOLS = [
  {
    name: "bridge_info",
    description: "브리지 설정 상태(키 등록 여부, 모델, 단가, 제출 상한)를 돌려준다. 키 값은 절대 포함하지 않는다.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: bridgeInfo,
  },
  {
    name: "estimate_video",
    description: "영상 클립 견적(최저 사양 단가 기준, USD)을 계산한다. 생성하지 않는다.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", enum: Object.keys(DEFAULT_MODELS) },
        duration: { type: "number", description: "클립 길이(초)" },
        clips: { type: "number", description: "클립 수" },
      },
      required: ["model", "duration", "clips"],
    },
    annotations: { readOnlyHint: true },
    run: estimate,
  },
  {
    name: "upload_images",
    description: "공개 이미지 URL을 서버가 내려받아 Higgsfield 저장소에 올리고 영상 입력용 public_url을 돌려준다. 최대 12장.",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, maxItems: 12 },
        referer: { type: "string", description: "원본 사이트 주소(핫링크 차단 우회용, 선택)" },
      },
      required: ["urls"],
    },
    run: uploadImages,
  },
  {
    name: "submit_videos",
    description: "시작 이미지 기반 영상 클립을 Higgsfield API에 제출한다(비용 발생). 견적이 서버 상한이나 max_total_usd를 넘으면 제출하지 않는다. 같은 클립을 두 번 제출하지 말 것.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", enum: Object.keys(DEFAULT_MODELS) },
        duration: { type: "number" },
        resolution: { type: "string", description: "Seedance 전용: 480p/720p/1080p" },
        cfg_scale: { type: "number", description: "Kling 전용 0~1, 기본 0.5" },
        max_total_usd: { type: "number", description: "사용자가 승인한 총액 한도" },
        clips: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: { key: { type: "string" }, image_url: { type: "string" }, prompt: { type: "string" } },
            required: ["image_url", "prompt"],
          },
        },
      },
      required: ["model", "duration", "clips"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: submitVideos,
  },
  {
    name: "submit_film",
    description: "참조 이미지 여러 장과 컷표 프롬프트로 음악·효과음이 포함된 홍보영상 한 편을 생성 요청한다(비용 발생). 견적이 서버 상한이나 max_total_usd를 넘으면 제출하지 않는다. 같은 영상을 두 번 제출하지 말 것.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", enum: Object.keys(DEFAULT_MODELS).filter((k) => DEFAULT_MODELS[k].r2v) },
        duration: { type: "number", description: "영상 길이(초)" },
        resolution: { type: "string", description: "480p/720p(2.5) 또는 480p/720p/1080p(2.0)" },
        aspect_ratio: { type: "string", enum: ASPECTS },
        prompt: { type: "string", description: "컷표가 들어간 영상 문안. 참조 이미지는 '이미지1'처럼 순서 번호로 가리킨다." },
        image_urls: { type: "array", items: { type: "string" }, maxItems: 30 },
        generate_audio: { type: "boolean", description: "음악·효과음 생성, 기본 true" },
        max_total_usd: { type: "number", description: "사용자가 승인한 총액 한도" },
      },
      required: ["model", "duration", "prompt", "image_urls"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: submitFilm,
  },
  {
    name: "finalize_video",
    description: "완성된 영상에 마지막 내레이션(mp3 base64)을 얹고 음악을 살짝 낮춘 뒤 -14 LUFS·최고치 -1dB로 맞춘 최종 mp4를 만들어 다운로드 주소를 돌려준다. 내레이션 없이 음량만 맞출 수도 있다. 영상 재생성 비용은 없다.",
    inputSchema: {
      type: "object",
      properties: {
        video_url: { type: "string" },
        narration_base64: { type: "string", description: "tts가 돌려준 audio_base64" },
        narration_start: { type: "number", description: "내레이션 시작 초. 없으면 끝에 맞춘다" },
        end_pad: { type: "number", description: "내레이션이 끝난 뒤 남길 여백(초), 기본 0.6" },
        duck: { type: "number", description: "내레이션 동안 음악 음량 비율 0.1~1, 기본 0.4" },
        lufs: { type: "number", description: "목표 음량, 기본 -14" },
      },
      required: ["video_url"],
    },
    run: finalizeVideo,
  },
  {
    name: "video_status",
    description: "제출한 요청들의 상태와 완료된 영상 URL을 조회한다. 최대 12개.",
    inputSchema: {
      type: "object",
      properties: { request_ids: { type: "array", items: { type: "string" }, maxItems: 12 } },
      required: ["request_ids"],
    },
    annotations: { readOnlyHint: true },
    run: statusOf,
  },
  {
    name: "cancel_video",
    description: "대기 중인 영상 요청을 취소한다.",
    inputSchema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] },
    run: cancel,
  },
  {
    name: "tts",
    description: "Fish Audio로 나레이션 한 줄(최대 500자)을 mp3로 만든다. audio_base64로 돌려준다.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        reference_id: { type: "string", description: "Fish Audio 목소리 ID(없으면 기본 목소리)" },
        speed: { type: "number", description: "0.5~2.0, 기본 1" },
        bitrate: { type: "number", enum: [64, 128, 192] },
      },
      required: ["text"],
    },
    run: fishTts,
  },
  {
    name: "tts_voices",
    description: "Fish Audio 목소리를 검색한다. 기본은 한국어, 라이선스 확보된 목소리만. self=true면 내가 만든 목소리.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        language: { type: "string" },
        licensed: { type: "boolean" },
        self: { type: "boolean" },
        page_size: { type: "number" },
      },
    },
    annotations: { readOnlyHint: true },
    run: fishVoices,
  },
];

/* ---------------- MCP(Streamable HTTP, stateless JSON) ---------------- */
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const error = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (id === undefined || id === null) return null; // notification
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: "유킷 스튜디오 숙소 홍보영상 파이프라인용 브리지. submit_videos와 submit_film은 비용이 발생하므로 사용자 승인 후 한 번만 호출할 것.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return error(-32602, `Unknown tool: ${params?.name}`);
      try {
        const out = await tool.run(params?.arguments || {});
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out });
      } catch (e) {
        const message = e instanceof ToolError ? e.message : `서버 오류: ${String(e?.message || e).slice(0, 200)}`;
        if (!(e instanceof ToolError)) console.error("[stay-bridge] tool failure", params?.name, String(e?.message || e).slice(0, 200));
        return reply({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

export default async function handler(req, res) {
  const token = req.query?.token;
  if (!process.env.BRIDGE_TOKEN || !safeEqual(token, process.env.BRIDGE_TOKEN)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (req.method === "GET" || req.method === "DELETE") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (req.method !== "POST") { res.status(405).end(); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) { res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }

  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(handleRpc))).filter(Boolean);
  if (!replies.length) { res.status(202).end(); return; }
  res.setHeader("Content-Type", "application/json");
  res.status(200).send(JSON.stringify(batch ? replies : replies[0]));
}
