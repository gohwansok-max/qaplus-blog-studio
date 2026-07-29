# QA PLUS Blog Studio

QA PLUS YouTube 대본을 Blogger용 실무 글로 변환하고 검토·발행하는 정적 웹앱입니다.

## 주요 기능

- YouTube 주소, 주제, 최종 승인 대본 입력
- QA PLUS 현장 전문가 페르소나 기반 AI 글 생성
- API 없이 사용할 수 있는 구조 초안 생성
- SEO 제목, 검색 설명, 라벨, 키워드 편집
- Blogger 안전 HTML 정리와 실제 글 미리보기
- YouTube 영상 및 QA PLUS 무료자료 자동 연결
- Google OAuth를 통한 Blogger 임시저장 또는 발행
- YouTube 영상 ID 기준 중복 전송 방지

## 공식 연결

- 블로그: https://qaplus-haccp.blogspot.com/
- YouTube: https://youtube.com/@qaplus_haccp
- 무료자료: https://drive.google.com/drive/folders/1tHqeagzD__Oqjc027TVJhcWQC0JkOIV6?usp=sharing

## 사용 방법

1. GitHub Pages로 배포된 앱에 접속합니다.
2. 영상 주소, 핵심 주제, 최종 승인 대본을 입력합니다.
3. `AI로 전문 글 생성` 또는 `API 없이 초안 만들기`를 선택합니다.
4. 제목, 검색 설명, 라벨, 본문을 검토합니다.
5. `발행 전 검사`를 실행합니다.
6. Google Blogger 연결 후 기본값인 `임시저장`으로 전송합니다.

## AI 설정

앱은 OpenAI 호환 Chat Completions API를 사용합니다. 기본 주소는 CheapSub 게이트웨이입니다.
API 키는 소스 코드에 포함되지 않고 현재 브라우저 탭의 `sessionStorage`에만 임시 저장됩니다.
공용 PC에서는 키를 입력하지 마세요.

## Blogger OAuth 설정

Google Cloud Console에서 웹 애플리케이션 OAuth Client ID를 만들고 다음을 설정해야 합니다.

- 승인된 JavaScript 원본: GitHub Pages 배포 주소
- OAuth 동의 화면의 Blogger API 범위: `https://www.googleapis.com/auth/blogger`
- Blogger API 활성화

OAuth Access Token은 메모리에만 유지되며 새로고침하면 사라집니다.
기본 발행 모드는 안전을 위해 항상 `임시저장`입니다.

## 보안 원칙

- API 키, Google Client Secret, OAuth Token을 저장소에 커밋하지 않습니다.
- 실제 회사명, 제품명, 사람, 연락처, 인증번호가 포함된 대본은 익명화한 뒤 외부 AI에 전송합니다.
- 생성 결과는 법적·인증 판단을 대신하지 않으며 반드시 사람이 최종 검토합니다.

## 로컬 실행

별도 빌드 과정이 없는 단일 HTML 앱입니다.

```bash
python -m http.server 4173
```

그다음 `http://localhost:4173/`에 접속합니다.

## 배포

GitHub Pages에서 `main` 브랜치의 `/ (root)`를 소스로 선택하면 됩니다.