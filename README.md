# stay-bridge

유킷 스튜디오 **스테이 소스 메이커**(claude.ai 아티팩트)가 Higgsfield API(영상)와 Fish Audio API(나레이션)를 쓰도록 이어 주는 MCP 브리지입니다. Vercel 함수 하나로 동작하고 의존성이 없습니다.

```
아티팩트 → claude.ai 커스텀 커넥터 → https://<배포주소>/m/<BRIDGE_TOKEN> → Higgsfield API / Fish Audio API
```

## 환경변수 (Vercel > Settings > Environment Variables)

| 이름 | 필수 | 설명 |
|---|---|---|
| `HF_API_KEY` | ✔ | open.higgsfield.ai에서 복사한 키 전체(그대로 붙여넣기) |
| `FISH_API_KEY` | ✔ | fish.audio 개발자 대시보드 API 키 |
| `BRIDGE_TOKEN` | ✔ | 커넥터 주소에 들어가는 비밀 토큰. 영문·숫자 32자 이상 |
| `FISH_MODEL` |  | 기본 `s2.1-pro-free`(무료). 유료 전환 시 `s2.1-pro` |
| `MAX_BATCH_USD` |  | 한 번에 제출할 수 있는 영상 견적 상한, 기본 10 |
| `MAX_CLIPS` |  | 한 번에 제출할 수 있는 클립 수, 기본 8 |
| `PRICES_JSON` |  | 콘솔에서 확인한 초당 단가로 덮어쓰기. 예: `{"kling-3-pro":0.11}` |

환경변수를 바꾼 뒤에는 **Redeploy** 해야 반영됩니다.

## 도구

| 도구 | 비용 | 설명 |
|---|---|---|
| `bridge_info` | 없음 | 키 등록 여부, 모델, 단가, 상한 |
| `estimate_video` | 없음 | 클립 견적(최저 사양 단가 기준) |
| `upload_images` | 없음 | 공개 사진 URL → Higgsfield 저장소 public_url |
| `submit_videos` | **발생** | 시작 이미지 기반 영상 제출. 상한 초과 시 거부 |
| `video_status` | 없음 | 상태·영상 URL 조회 |
| `cancel_video` | 없음 | 대기 중 요청 취소 |
| `tts` | 무료 모델 기준 없음 | Fish Audio 나레이션 한 줄 → mp3(base64) |
| `tts_voices` | 없음 | 한국어·라이선스 확보 목소리 검색 |
| `scrape_site` | 없음 | 서울 리전에서 숙소 사이트 본문·사진 후보(썸네일)를 수집. 해외 IP를 막는 국내 사이트 대응 |
| `upload_tickets` | 없음 | 클라우드 브라우저가 받은 사진을 직접 올릴 일회용 업로드 주소 발급 |
| `submit_film` | **발생** | 참조 사진 여러 장 + 컷표 프롬프트로 음악 포함 홍보영상 한 편 생성 (Seedance 2.5/2.0 reference-to-video) |
| `finalize_video` | 없음 | 완성 영상에 마지막 내레이션을 얹고 음악을 살짝 낮춘 뒤 -14 LUFS·-1 dBTP로 맞춘 최종 mp4 주소 반환 |

## 모델 경로

`higgsfield-ai/app-templates`(studio) 카탈로그 기준입니다.

- Kling 3.0 Standard: `kling-video/v3.0/std/image-to-video`
- Kling 3.0 Pro: `kling-video/v3.0/pro/image-to-video`
- Seedance 2.0: `bytedance/seedance-2.0/image-to-video`
- Seedance 2.0 Fast: `bytedance/seedance-2.0/fast/image-to-video`
- Seedance 2.0 참조 영상: `bytedance/seedance-2.0/reference-to-video` (참조 9장, 4~15초, 1080p 가능)
- Seedance 2.5 참조 영상: `bytedance/seedance-2.5/reference-to-video` (참조 30장, 4~30초, 480p/720p)

함수는 `vercel.json`의 `regions: ["icn1"]`로 서울에서 실행됩니다(국내 숙소 사이트의 해외 접속 차단 대응).

최종본 합성은 `ffmpeg-static`(GPL 바이너리)을 함수에 포함해 처리합니다(`vercel.json`의 `includeFiles`).

## 보안

- 키는 환경변수에서만 읽고 응답·로그에 싣지 않습니다.
- 토큰이 틀린 요청은 404로 응답합니다.
- 토큰이 새면 `BRIDGE_TOKEN`을 바꾸고 Redeploy한 뒤 커넥터 주소를 갱신하세요.
- 잔액은 소액 선불로 유지하고 자동 충전은 끄세요.
