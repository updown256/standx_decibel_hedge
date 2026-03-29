# StandX × Decibel Hedge Volume Bot

두 거래소에서 양빵 헷징으로 거래량을 생성하는 자동 봇.
한쪽 Long + 반대쪽 Short → 주기적 전환 → 볼륨 누적.

## 보안

- **프라이빗 키는 절대 디스크에 저장되지 않습니다** — 실행 시 대화형 입력, 메모리에만 존재
- **프라이빗 키는 절대 네트워크로 전송되지 않습니다** — 로컬 서명에만 사용
- **프로세스 종료 시 메모리에서 즉시 삭제됩니다**
- 검증: 소스코드에서 `fs.write` + key 변수명 검색 시 저장/전송 코드 없음

## 빠른 시작

### 소스에서 실행
```bash
npm install
npm run dev
```

### EXE로 빌드
```bash
npm run pkg
# → bin/hedge-bot-macos, bin/hedge-bot-win.exe, bin/hedge-bot-linux
```

### EXE 실행
```bash
./bin/hedge-bot-macos   # macOS
./bin/hedge-bot-win.exe  # Windows
./bin/hedge-bot-linux    # Linux
```

## 설정

실행 시 대화형 프롬프트로 모든 설정을 입력합니다:

### 인증 정보
| 항목 | 설명 |
|------|------|
| StandX EVM Private Key | BSC 지갑 프라이빗 키 (0x...) |
| Decibel API Wallet Private Key | Aptos API 지갑 프라이빗 키 |
| Decibel API Wallet Address | Aptos API 지갑 주소 |
| Decibel Bearer Token | Geomi에서 발급한 Bearer 토큰 |
| Decibel Trading Account | (선택) 서브계정 주소 |

### 트레이딩 설정
| 항목 | 기본값 | 설명 |
|------|--------|------|
| Symbol | BTC | 거래 심볼 |
| Order Size | - | 주문 수량 (예: 0.001) |
| Leverage | 5 | 레버리지 배수 |
| Price Tolerance | $1 | 가격 허용 오차 |
| Rotation Mode | random | fixed 또는 random |
| Fixed Interval | 300s | 고정 주기 (최소 60초) |
| Random Range | 60s-600s | 랜덤 범위 |

## 동작 원리

```
1. StandX: Long BUY  +  Decibel: Short SELL  (동시)
2. 체결 확인 → 설정 시간만큼 대기
3. 양쪽 동시 청산 (reduce_only)
4. 사이드 스왑 (Long↔Short 교체)
5. StandX: Short SELL  +  Decibel: Long BUY  (동시)
6. 반복 → 볼륨 누적
```

## 수수료 전략

- **양쪽 모두 Maker(지정가) 주문** 사용
- StandX ALO: 0.01% | Decibel Post-Only: 0.011%
- 왕복 수수료: ~0.042% (Market 사용 시 0.148% — 3.5배 절약)

## 로그

- 실시간 터미널 출력: 포지션, 볼륨, 수수료, PnL
- CSV 파일: `logs/trades_YYYY-MM-DD.csv`

## 구조

```
src/
├── index.ts              # 메인 엔트리포인트
├── clients/
│   ├── standx.ts         # StandX REST/WS 클라이언트
│   └── decibel.ts        # Decibel Aptos/REST 클라이언트
├── core/
│   ├── hedger.ts         # 헷지 오케스트레이터
│   └── tracker.ts        # 수수료/PnL 추적 + CSV
└── utils/
    ├── config.ts         # 대화형 설정 입력
    ├── security.ts       # 키 보안 (메모리 볼트)
    └── types.ts          # 타입 정의
```
