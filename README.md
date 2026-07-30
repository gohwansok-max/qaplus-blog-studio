# QA PLUS Blog Studio

QA PLUS 공개 YouTube 영상을 근거로 Blogger용 식품안전 실무 글을 만들고, 검토 후 임시저장 또는 발행하는 단일 HTML PWA입니다.

## 5단계 AI 파이프라인

1. **Gemini 대본 추출** — 공개 YouTube 영상의 음성과 화면을 분석해 타임스탬프 대본과 장면 메모를 만듭니다.
2. **ChatGPT 1단계 분석** — `gpt-5.6-sol`이 근거, 검색 의도, 확인이 필요한 주장, 글 구성과 표 계획을 JSON으로 정리합니다. 선택 모델이 429·5xx·빈 응답 또는 일시적인 `model_not_allowed`이면 CheapSub 지원 모델인 Sol·DeepSeek·GLM·Terra·Luna를 순서대로 확인하고, 정상 응답 모델을 현재 탭 설정에 반영합니다.
3. **Claude 1차 기본 글** — `claude-opus-5`가 분석 결과와 대본을 바탕으로 긴 글의 뼈대와 기본 설명을 씁니다.
4. **Claude 2차 살붙이기** — 같은 Claude 모델이 1차 글을 보존한 채 사례, 실수, 체크리스트, HTML 표 1~2개, FAQ를 2,200~4,200자 단위의 확장 조각으로 최대 3회 추가합니다. 각 조각은 출력이 잘려도 안전하게 HTML을 복구하며, 6천·9천·1만2천 자 목표의 90%와 표 개수를 충족할 때까지 길이를 검사합니다. 빈 응답이 오면 Opus를 재시도하고 Sonnet으로 전환하며, 둘 다 비어 있을 때만 현재 정상인 ChatGPT 모델이 같은 확장 조각 형식으로 대신 작성합니다.
5. **OpenAI 이미지 생성** — CheapSub `/v1/images/generations`의 `gpt-image-2`를 최신 GPT Image 요청 규격(1536×1024, medium, JPEG)으로 호출해 기본 3장의 실사 B-roll 이미지를 만들고 본문에 삽입합니다. 일시 장애는 장당 최대 3회 확인하며, 중간에 멈춰도 성공한 이미지와 본문을 보존하고 재실행 시 실패한 슬롯만 이어서 만듭니다. 같은 슬롯을 다시 실행해도 본문 이미지가 중복되지 않습니다.

글 길이 기본값은 **아주 풍성하게 9,000자**, 이미지 기본값은 **대표+본문 3장**입니다. 실패하면 완료된 단계 결과를 유지하고 **실패 단계부터 다시 실행**할 수 있습니다.

이미 발행된 같은 영상·제목의 Blogger 글이 있으면 새 글을 중복 생성하지 않습니다. **Blogger로 보내기**를 눌렀을 때 기존 글을 확인하고, 사용자 확인 후 이미지가 포함된 현재 본문으로 업데이트합니다. 새 글은 Blogger API가 요구하는 제목·본문·라벨만 전송하며, 바로 발행을 선택하면 Blogger가 반환한 글 ID와 공개 URL을 확인한 뒤 완료로 표시합니다.

각 단계 카드에는 독립적인 **결과 보기** 창이 있습니다. Gemini 대본과 ChatGPT 분석은 원문으로, Claude 1차·2차 글은 실제 글 형태의 미리보기와 JSON·HTML 원문으로, OpenAI 이미지는 이미지와 사용 프롬프트로 각각 확인할 수 있습니다. 실행 중에도 완료된 단계의 창은 즉시 열 수 있습니다. 실패하면 해당 단계의 결과 창이 자동으로 열리고 HTTP 상태·상류 오류 원문·해결 방법을 표시합니다. Claude의 네트워크·429·5xx 오류는 최대 2회 자동 재시도하며, 1차 글은 출력 잘림을 줄이도록 약 2,600~4,200자의 태그 형식으로 요청합니다. Claude 1차·2차 글은 경제냠냠과 동일하게 CheapSub 직접 SSE 스트리밍으로 받아 결과 창에 실시간 표시합니다. 스트림 종료 사유가 누락되거나 출력 한도에서 글이 잘리면 현재까지 받은 원문을 보존하고 같은 Opus가 마지막 문자부터 최대 2회 자동으로 이어 씁니다. 직접 연결이 브라우저에서 막힐 때만 QA PLUS 중계를 사용하고, Opus 스트리밍이 반복적으로 524일 때만 `claude-sonnet-5`를 최종 예비 모델로 사용합니다.

## 처음 한 번 설정하기

### 1. Google Gemini API 키

- Google AI Studio에서 Gemini API 키를 발급합니다.
- 앱의 **설정·검증 → Google Gemini API 키**에 입력합니다.
- 기본 모델은 `gemini-3.6-flash`입니다.
- YouTube URL 직접 입력은 공개 영상만 지원합니다. 비공개·일부공개 영상은 승인 대본을 직접 입력하세요.

### 2. CheapSub API 키

- CheapSub에서 `csk_`로 시작하는 키를 발급하고 크레딧을 충전합니다.
- 앱의 **CheapSub API 키**에 입력합니다.
- ChatGPT 분석 기본 모델은 `gpt-5.6-sol`입니다. 공급자 모델 장애가 발생하면 앱이 재시도 가능한 오류만 판별해 Sol·DeepSeek·GLM·Terra·Luna 순으로 정상 모델을 찾습니다. 잘못된 키 같은 실제 인증 오류는 다른 모델로 숨기지 않고 즉시 표시합니다.
- ChatGPT 분석과 OpenAI 이미지는 휴대폰 CORS 오류를 피하도록 QA PLUS 전용 Cloudflare Worker `https://qa-plus-api.gohwansok.workers.dev`를 사용합니다.
  - ChatGPT 분석: 중계 `POST /v1/chat/completions`
  - Claude 작성·확장: CheapSub 직접 `POST https://api.cheapsub.im/v1/messages` + `stream:true` 우선, 연결 실패 시 중계 스트리밍
  - OpenAI 이미지: 중계 `POST /v1/images/generations`
- 중계 서버는 요청 경로만 전달하며, API 키는 HTML 소스에 저장하지 않고 브라우저의 현재 탭에서 요청 헤더로만 보냅니다.

경제냠냠과 같은 브라우저 프로필에서 열면 **경제냠냠 설정 가져오기**로 CheapSub 키와 Google OAuth Client ID를 불러올 수 있습니다. Gemini 키는 별도로 입력해야 합니다.

### 3. Google OAuth

Google OAuth는 AI 글 생성이 아니라 QA PLUS 영상 목록 조회와 Blogger 임시저장·발행에 사용합니다.

- 승인된 JavaScript 원본에 GitHub Pages 배포 주소를 등록합니다.
- Blogger API와 YouTube Data API v3를 활성화합니다.
- 앱에서 **Google·YouTube 권한 연결**을 누릅니다.
- 앱은 공개 블로그 조회만으로 연결 성공을 표시하지 않고, 승인 토큰에 Blogger 쓰기 범위가 포함됐는지와 현재 계정이 대상 블로그의 작성자인지까지 확인합니다.
- 기본 발행 모드는 안전을 위해 항상 **임시저장**입니다.

## 보안 원칙

- API 키와 OAuth 토큰을 HTML 소스에 넣지 않습니다.
- API 키는 현재 탭의 `sessionStorage`에만 저장되고, Google OAuth 토큰은 메모리에만 유지됩니다.
- 공용 PC에서는 키를 입력하지 마세요.
- 실제 회사명, 제품명, 개인정보가 포함된 대본은 익명화한 뒤 전송하세요.

## 로컬 실행

별도 빌드 과정이 없습니다.

```powershell
py -m http.server 4173
```

그다음 `http://localhost:4173/`을 엽니다.

## 배포

GitHub Pages에서 `main` 브랜치의 `/ (root)`를 배포 소스로 선택합니다.
