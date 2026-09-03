# rack3d-web 배포 절차

**이 문서는 2026-09-03 배포(`main-42782d6`) 때 서버에서 실제 스크립트를 읽고 확인해 쓴 것이다.**
그전까지 배포 절차는 **저장소 어디에도 없었고 buru-ext 서버에만 있었다.** 그래서 배포할 때마다
"어떻게 배포하더라"를 다시 찾아야 했고, 2026-09-03 에도 netis-fms 저장소의 주석
(`netis-fms/deploy/cicd/build.sh` 의 "기존 사내 패턴 `~/cicd/rack3d/build.sh`")을 거슬러 올라가서야
찾았다. 다시 그러지 않게 여기 적는다.

## 한 줄 요약

빌드도 배포도 **buru-ext 에서** 한다. 맥에서 `npm run build` 하거나 로컬 도커로 이미지를 만들지 않는다.

```bash
ssh buru-ext '~/cicd/rack3d/build.sh'    # GitHub main pull → 이미지 빌드 → 레지스트리 push
ssh buru-ext '~/cicd/rack3d/deploy.sh'   # 방금 빌드한 태그로 k8s 롤링 배포
```

`buru-ext` 는 `~/.ssh/config` 의 별칭이다. 호스트 주소·포트·계정은 저장소에 적지 않는다.

## ⚠️ 배포 전에 반드시

**1. 푸시했는지 확인한다.** 빌드 스크립트는 **GitHub `main` 을 pull 해서** 빌드한다.
로컬 작업 트리를 보지 않는다 — 푸시를 빠뜨리면 **옛 코드가 그대로 나간다.**

```bash
git rev-list --left-right --count origin/main...HEAD    # 0  0 이어야 한다
```

**2. 로컬 `kubectl` 을 쓰지 않는다.** 맥의 kubectl 컨텍스트는 **미니PC(`192.168.0.50:6443`)** 를
가리킨다. **rack3d 클러스터가 아니다.** 로컬에서 `kubectl -n rack3d ...` 를 치면 엉뚱한 클러스터를
보거나 아무것도 못 찾는다. k8s 명령은 전부 `ssh buru-ext` 안에서 돈다.

## 구성

| 항목 | 값 |
|---|---|
| 소스 | GitHub `sdbang-hamonsoft/rack3d-web` (브랜치 `main`) |
| 빌드 호스트 | buru-ext (k8s 노드와 같은 장비) |
| 레지스트리 | `10.1.20.21:5000` |
| 이미지 | `10.1.20.21:5000/rack3d-web:main-<단축sha>` (+ `:latest` 동시 태깅) |
| k8s | 네임스페이스 `rack3d`, Deployment `rack3d-web` |
| 서빙 경로 | `https://fms.burunet.co.kr/rack3d/` — **FMS 와 같은 오리진의 하위 경로** |

빌드는 buru-ext 의 도커 안(`node:20-alpine`)에서 돈다. 그래서 **맥의 node 아키텍처 문제
(rolldown 네이티브 바인딩)는 배포 경로에 해당하지 않는다.** 그건 로컬에서 `npm run build` 를
직접 돌릴 때만 나온다(→ 아래 "로컬에서 빌드해야 할 때").

## 스크립트가 실제로 하는 일

`~/cicd/rack3d/` 에 4개가 있다. 전부 ansible 플레이북 래퍼다.

**`build.sh` → `build.yml`**
1. `~/cicd/rack3d/build-cache/main` 에 GitHub `main` 을 pull (`force: yes`)
2. `git rev-parse --short HEAD` → 태그를 `main-<sha>` 로 정한다
3. `docker build -t <레지스트리>/rack3d-web:main-<sha> -t <레지스트리>/rack3d-web:latest .`
4. 두 태그 모두 push (실패 시 5회 재시도)
5. 로컬 이미지 `docker rmi` 로 정리
6. **태그를 `~/cicd/rack3d/.latest_build_tag` 에 기록** ← `deploy.sh` 가 이 파일을 읽는다

**`deploy.sh [태그] → deploy.yml`**
1. 태그 인자가 없으면 `.latest_build_tag` 를 읽는다
2. buru-ext 에서 `kubectl -n rack3d set image deployment/rack3d-web rack3d-web=<레지스트리>/rack3d-web:<태그>`
3. `kubectl -n rack3d rollout status deployment/rack3d-web` 로 완료를 기다린다

## ⚠️ `build.sh` 가 GitHub 토큰을 대화형으로 묻는다

`GITHUB_ID`·`GITHUB_TOKEN` 환경변수가 없으면 `read -p` 로 입력을 기다린다.
**비대화형 세션(에이전트·CI)에서는 여기서 멈춘다.**

토큰이 있으면 환경변수로 넘긴다:

```bash
ssh buru-ext 'GITHUB_ID=<id> GITHUB_TOKEN=<token> ~/cicd/rack3d/build.sh'
```

토큰이 없다면 — 저장소가 익명으로 읽히는지 확인한 뒤(`git ls-remote` 가 인증 없이 되는지)
같은 플레이북을 공개 URL 로 직접 호출할 수 있다. **2026-09-03 배포가 이 경로였다.**
태깅·빌드·푸시 로직은 `build.sh` 와 100% 동일하다(스크립트가 URL 만 조립해 넘긴다).

```bash
ssh buru-ext 'ansible-playbook -i "localhost," ~/cicd/rack3d/build.yml \
  -e "image_name=rack3d-web git_repo=https://github.com/sdbang-hamonsoft/rack3d-web.git target_branch=main"'
```

우회했으면 **빌드된 커밋을 반드시 대조한다** — 다른 것을 빌드해 놓고 성공으로 착각하기 쉽다:

```bash
ssh buru-ext 'git -C ~/cicd/rack3d/build-cache/main rev-parse HEAD'   # origin/main 과 같아야 한다
```

## 배포 후 검증 — **스크립트 성공은 배포 성공이 아니다**

`rollout status` 가 통과해도 "이번 변경이 라이브에서 보이는지"는 별개다. 최소 이 셋을 본다.

**1. 파드가 새 이미지로 Ready 인가**
```bash
ssh buru-ext 'kubectl -n rack3d get deploy rack3d-web -o jsonpath="{.spec.template.spec.containers[0].image}"; echo
                kubectl -n rack3d get pods'
```

**2. 새로 추가한 정적 파일이 실제로 내려오는가**
바이트 수만 보지 말고 **sha256 을 git 원본과 대조한다.** 크기가 같아도 옛 파일일 수 있다.
```bash
curl -sS -o /tmp/x.glb -w '%{http_code} %{size_download}\n' \
  'https://fms.burunet.co.kr/rack3d/models/objects/precision-ac.glb?v=12'
shasum -a 256 /tmp/x.glb
git show HEAD:public/models/objects/precision-ac.glb | shasum -a 256   # 같아야 한다
```

**3. `index.html` 이 참조하는 번들이 새것인가**
```bash
curl -sS https://fms.burunet.co.kr/rack3d/ | grep -o 'assets/index-[^"]*\.js'
```
옛 번들 경로가 여전히 200 이면 스테일 레이어가 남은 것이다(정상이면 404).

**4. 화면 육안 확인.** FMS 로그인 세션이 필요해 자동화 밖이다 — 사람이 본다.

## 되돌리기

```bash
ssh buru-ext '~/cicd/rack3d/deploy.sh main-<이전sha>'          # 권장 — 태그를 명시해 고정 배포
ssh buru-ext 'kubectl -n rack3d rollout undo deployment/rack3d-web'   # 직전 리비전으로
```

옛 태그는 레지스트리에 남아 있다. 목록:
```bash
ssh buru-ext 'curl -s http://10.1.20.21:5000/v2/rack3d-web/tags/list'
```

## GLB·정적 파일을 바꿨을 때

- **GLB 는 `?v=${MODEL_VERSION}` 로 무효화한다.** 모델을 바꿨으면 `src/App.tsx` 의
  `MODEL_VERSION` 을 올린다. **안 올리면 nginx 의 `max-age=15552000`(180일) 캐시에 걸려
  기존 사용자는 옛 모델을 본다.**
- **`public/` 의 다른 정적 파일에는 무효화 장치가 없다**(로고 등). 백로그 항목 참조.

## 로컬에서 빌드해야 할 때 (배포 경로 아님)

`npm run build` 가 `Cannot find native binding` 으로 죽는다. **코드 문제가 아니다** —
PATH 기본 node(`~/.local/node/bin/node`)가 **x64 빌드**라 Rosetta 로 돌고,
`node_modules` 에는 `@rolldown/binding-darwin-arm64` 만 있다.

```bash
PATH=/opt/homebrew/bin:$PATH npm run build
```

## 배포 기록

배포할 때마다 `docs/fms-integration-security.md` 에 §11-xx 로 남긴다
(§11-32 · §11-34 · §11-36 · §11-39). 이미지 태그·커밋·직전 운영본·검증 결과·되돌리기 명령을 적는다.
