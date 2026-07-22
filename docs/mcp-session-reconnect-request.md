# 수정 요청: `McpToolbox`가 만료된 MCP 세션을 재연결하지 않음

**작성일:** 2026-07-21
**대상:** `dolsot/mcp.py` (`McpToolbox`, v0.4.0)
**분류:** robustness / bug
**우선순위:** 높음 — 장수명 호스트(상주 에이전트 서버)에서 tool이 프로세스 재시작 전까지 영구 실패

## 요약

`McpToolbox`는 **하나의 MCP 세션을 프로세스 수명 동안 유지**하고, 그 세션이 서버측에서
만료되면(idle timeout 등) **재연결하지 않는다**. 이후 모든 tool 호출이 죽은 세션으로 나가
실패하며, `close()` 후 새 `McpToolbox`를 만들기 전까지 복구되지 않는다.

## 영향 (실사례)

Jipler(상주 AgentOS 집사)에서 봇마다 `McpToolbox.http(...)`를 **한 번 만들어 앱 수명 내내
재사용**한다(원격 not-foundry MCP 게이트웨이). 컨테이너가 얼마간 유휴 상태였다가 tool을 호출하니
게이트웨이가 `POST /mcp`에 **HTTP 404**를 반복 반환했다(streamable-HTTP에서 404 = 세션 없음/만료).
봇의 모든 tool이 실패했고, **컨테이너를 재시작**(= 새 `McpToolbox`)해야만 복구됐다.

격리 검증:
- **새로 만든 `McpToolbox`**로 `sync run`과 `async arun` 경로 모두 정상(실데이터 반환).
- **오래된(유휴 후) `McpToolbox`**는 404로 실패.
- 즉 전송/async 경로 문제가 아니라 **세션 만료 + 재연결 부재**가 원인.

## 근본 원인 (`dolsot/mcp.py`)

`_service`(라인 123~)가 백그라운드 루프에서 **단 한 번** 연결을 열고, 그 세션으로 큐를 서빙한다:

```python
async def _service(self):
    async with self._connect() as session:        # 연결 1회 수립
        ...discover tools...
        while True:
            name, arguments, fut = await self._queue.get()
            try:
                result = await session.call_tool(name, arguments)   # ← 실패해도
            except BaseException as exc:
                fut.set_exception(exc)                               # ← 예외만 전달
            else:
                fut.set_result(result)
            # 루프는 같은 (죽은) session으로 계속 진행 → 재연결 없음
```

- 세션은 `_ensure_started`(라인 181~)에서 최초 1회만 열리고 `close()`(라인 297~) 전까지 재수립되지 않는다.
- `session.call_tool`이 전송 수준 실패(세션 만료/404)를 던져도 `while` 루프는 **동일한 죽은
  세션으로 다음 요청을 계속 처리**한다. 재연결 경로가 없다.

## 재현

1. 원격 streamable-HTTP MCP 서버(세션 idle TTL 있음)에 `McpToolbox.http(url, token=...)`로 연결.
2. tool 한 번 호출(정상).
3. 서버측 세션 TTL을 넘겨 유휴 상태 유지(예: 수 분).
4. 다시 tool 호출 → `POST /mcp`가 404 → `McpToolError`/전송 예외. 이후 모든 호출 동일 실패.
5. `close()` 후 새 `McpToolbox`를 만들면 복구.

## 제안 수정 (택1, 재연결 로직을 `_service`에 도입)

**옵션 A — 호출 실패 시 재연결 후 1회 재시도 (권장).**
`session.call_tool`이 **전송/세션 수준 실패**(연결 종료, 세션 없음/404 등)를 던지면, 현재
`async with self._connect()` 블록을 빠져나가 **다시 연결·initialize·재사용**한 뒤 그 요청을
한 번 재시도한다. 애플리케이션 수준 tool 오류(`is_error` 결과)는 재시도하지 않는다(구분 필요).
재시도 대상은 아직 서버에 부작용을 일으키지 않은 전송 실패로 한정한다(중복 write 방지).

**옵션 B — 유휴/주기 기반 선제 재연결.**
마지막 성공 사용 이후 유휴가 임계(예: 세션 TTL의 절반)를 넘으면 다음 요청 전에 세션을
닫고 새로 연다. 오류 판별이 불필요하고 부작용 재시도 위험이 없다. 단 TTL을 알아야 한다
(파라미터로 노출: `session_idle_ttl` 등).

**옵션 C — 재연결 훅/헬스 API 노출.**
`McpToolbox.reconnect()` 또는 자동 재연결 정책 플래그(`reconnect="on_error" | "idle" | "never"`)를
`http()/stdio()`에 추가해 소비자가 선택하게 한다.

### 권장
기본 동작으로 **옵션 A(전송 실패 시 재연결 + 1회 재시도)**를 넣고, 필요 시 **옵션 B의
`session_idle_ttl`**를 함께 노출한다. 상주 서버에서 "한 번 붙여 오래 쓰는" 사용이 표준이므로
소비자가 매 호출마다 툴박스를 재생성하지 않아도 자가 치유돼야 한다.

## 수용 기준

- 서버가 세션을 만료시켜 한 호출이 전송 실패해도, **다음(또는 재시도) 호출이 자동 재연결로
  성공**한다(같은 `McpToolbox` 인스턴스, `close()`/재생성 없이).
- 애플리케이션 tool 오류(`is_error`)는 재시도 없이 그대로 전달된다(중복 부작용 없음).
- 재연결은 tool 호출 사이(요청 경계)에서만 일어나 **부분 실행 셀/중복 write가 발생하지 않는다**.
- 회귀 테스트: (1) mock MCP 서버가 첫 세션에서 특정 호출에 세션-만료류 예외를 던지고,
  두 번째 세션에서는 정상 응답 → 소비자 관점에서 tool이 성공. (2) 애플리케이션 오류는 재시도
  없이 1회로 표면화.

## 소비자측 임시 우회 (참고)

`dolsot` 수정 전까지 Jipler는 `_ToolboxProxy`가 raw 툴박스 대신 **holder**를 가리키게 하고,
유휴가 임계를 넘으면 holder가 툴박스를 닫고 새로 만들도록 하는 유휴-기반 선제 재연결을
애플리케이션 쪽에 둘 수 있다(옵션 B의 소비자측 구현). 재연결이 dolsot에 들어오면 이 우회는 제거한다.
