# QA PLUS Blog Studio

QA PLUS 공개 YouTube 영상을 근거로 Blogger용 식품안전 실무 글을 만들고, 검토 후 임시저장 또는 발행하는 단일 HTML PWA입니다.

## 5단계 AI 파이프라인

1. **Gemini 대본 추출** — 공개 YouTube 영상의 음성과 화면을 분석해 타임스탬프 대본과 장면 메모를 만듭니다.
2. **ChatGPT 1단계 분석** — `gpt-5.6-sol`이 근거, 검색 의도, 확인이 필요한 주장, 글 구성과 표 계획을 JSON으로 정리합니다.
3. **Claude 1차 기본 글** — `claude-opus-5`가 분석 결과와 대본을 바탕으로 긴 글의 뼈대와 기본 설명을 씁니다.
4. **Claude 2차 살붙이기** — 같은 Claude 모델이 사례, 실수, 체크리스트, HTML 표 1~2개, FAQ를 더해 6천·9천·1만2천 자 목표의 최종 글로 확장합니다. 목표의 90%에 못 미치면 같은 단계에서 자동 보강하고 다시 길이를 검사합니다.
5. **OpenAI 이미지 생성** — CheapSub `/v1/images/generations`의 `gpt-image-2`로 기본 3장의 실사 B-roll 이미지를 만들고 본문에 삽입합니다.

글 길이 기본값은 **아주 풍성하게 9,000자**, 이미지 기본값은 **대표+본문 3장**입니다. 실패하면 완료된 단계 결과를 유지하고 **실패 단계부터 다시 실행**할 수 있습니다.

각 단계 카드에는 독립적인 **결과 보기** 창이 있습니다. Gemini 대본과 ChatGPT 분석은 원문으로, Claude 1차·2차 글은 실제 글 형태의 미리보기와 JSON·HTML 원문으로, OpenAI 이미지는 이미지와 사용 프롬프트로 각각 확인할 수 있습니다. 실행 중에도 완료된 단계의 창은 즉시 열 수 있습니다. 실패하면 해당 단계의 결과 창이 자동으로 열리고 HTTP 상태·상류 오류 원문·해결 방법을 표시합니다. Claude의 네트워크·429·5xx 오류는 최대 2회 자동 재시도하며, 1차 글은 출력 잘림을 줄이도록 약 2,600~4,200자의 태그 형식으로 요청합니다.

## 처음 한 번 설정하기

### 1. Google Gemini API 키

- Google AI Studio에서 Gemini API 키를 발급합니다.
- 앱의 **설정·검증 → Google Gemini API 키**에 입력합니다.
- 기본 모델은 `gemini-3.6-flash`입니다.
- YouTube URL 직접 입력은 공개 영상만 지원합니다. 비공개·일부공개 영상은 승인 대본을 직접 입력하세요.

### 2. CheapSub API 키

- CheapSub에서 `csk_`로 시작하는 키를 발급하고 크레딧을 충전합니다.
- 앱의 **CheapSub API 키**에 입력합니다.
- 휴대폰 브라우저의 CORS 오류를 피하기 위해 기본 연결은 QA PLUS 전용 Cloudflare Worker `https://qa-plus-api.gohwansok.workers.dev`를 사용합니다. 앱에서 예전 CheapSub 직접 주소를 불러와도 중계 주소로 자동 변환합니다.
  - ChatGPT 분석: `POST /v1/chat/completions`
  - Claude 작성·확장: `POST /v1/messages`
  - OpenAI 이미지: `POST /v1/images/generations`
- 중계 서버는 요청 경로만 전달하며, API 키는 HTML 소스에 저장하지 않고 브라우저의 현재 탭에서 요청 헤더로만 보냅니다.

경제냠냠과 같은 브라우저 프로필에서 열면 **경제냠냠 설정 가져오기**로 CheapSub 키와 Google OAuth Client ID를 불러올 수 있습니다. Gemini 키는 별도로 입력해야 합니다.

### 3. Google OAuth

Google OAuth는 AI 글 생성이 아니라 QA PLUS 영상 목록 조회와 Blogger 임시저장·발행에 사용합니다.

- 승인된 JavaScript 원본에 GitHub Pages 배포 주소를 등록합니다.
- Blogger API와 YouTube Data API v3를 활성화합니다.
- 앱에서 **Google·YouTube 권한 연결**을 누릅니다.
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
