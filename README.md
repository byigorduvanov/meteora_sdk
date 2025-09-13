## Meteora DLMM Node Helper

Сервіс для взаємодії з Meteora DLMM  SDK на Solana: створення позицій ліквідності, батч‑вихід із позицій і автосвоп залишків через Jupiter. Побудовано на `@meteora-ag/dlmm/SDK`, `@solana/web3.js`, `Express`.

### Структура репозиторію
- `node_helper/` — сервіс на Node.js (TypeScript → dist) з REST‑API
  - `src/index.ts` — HTTP API (Express)
  - `src/sdk_liquidity.ts` — логіка введення/виходу через DLMM SDK
  - `src/meteora.ts` — обгортки DLMM + API Meteora
  - `src/jupiter.ts` — інтеграція з Jupiter Lite API
  - `src/wallet.ts` — завантаження ключа гаманця з `.env`
  - `scripts/add_via_sdk.ts` — CLI приклад додавання ліквідності в діапазон бінів
  - `Dockerfile` — multi‑stage build (builder → runner)
- `docker-compose.yml` — швидкий запуск сервісу у контейнері
- `docs/meteora_sdk.txt` — витримка для AI документації DLMM SDK

### Вимоги
- Node.js 20+
- Гаманець Solana (секретний ключ у `.env`)
- RPC вузол Solana (mainnet або інший) в моєму випадку HELIOS

### Встановлення (локально)
```bash
cd node_helper
npm ci
npm run build
npm start
```

Або для розробки з перезавантаженням:
```bash
npm run dev
```

### Змінні оточення (`node_helper/.env`)
Мінімальний приклад:
```
PORT=4000
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Один з варіантів секрету ( тільки один):
# 1) Base58 секрет (може бути seed(32) або повний secretKey)
WALLET_SECRET_BASE58=
# 2) JSON масив байтів secretKey
# WALLET_SECRET_JSON=[12,34,...]


```

Секрет гаманця потрібен для підпису транзакцій. Код читає або `WALLET_SECRET_BASE58` (base58), або `WALLET_SECRET_JSON` (масив байтів).

### Запуск через Docker Compose
У корені:
```bash
docker compose up --build
```

Параметри з `docker-compose.yml`:
- Порт: `PORT` (дефолт 4000)
- Мапінг ключа: змінна `KEYPAIR_HOST_PATH` підмонтовується в контейнер як `/app/id.json` (read‑only). Якщо використовуєш `.env`‑секрети, монтування не обовʼязкове.
- Перевірка здоровʼя: `GET /health`

### REST API
Базовий URL: `http://localhost:4000`

- `GET /health`
  - Перевірка доступності сервісу.

- `POST /pool/:address/enter-auto-sol`
  - Вхід у пул за бюджетом SOL з розподілом у токен/WSOL і автодіапазоном вгору (`upPct`) з обмеженням кількості бінів.
  - Body:
    ```json
    {
      "solTotal": 1.5,
      "ratio": "50:50",             
      "strategy": "BidAsk",         // Spot | BidAsk | Curve
      "upPct": 10,
      "slippageBps": 100,
      "dynamicSlippage": true
    }
    ```
  - Відповідь: адреса позиції, діапазон бінів, tx сигнатури.

### Main логіка
- `POST /pool/:address/enter-split-multi`
  - Розбиття суміжного діапазону на кілька позицій згідно з лімітом бінів: вверх покривається токен‑частиною, вниз — WSOL‑частиною.
  - Body:
    ```json
    {
      "solTotal": 2.0,
      "ratio": 60,                   // 60% у токен, 40% у WSOL
      "strategy": "Spot",
      "upPct": 80,
      "downPct": 70,
      "slippageBps": 100,
      "dynamicSlippage": true
    }
    ```
  - Відповідь: створені позиції (масив), покриття бінів, ліміти.

- `POST /pool/:address/exit-all-and-sell`
  - Закриває всі відомі сервісу позиції для пулу (з локального реєстру або попередньо зареєстровані) і продає залишки у `outMint` через Jupiter.
  - Body (усі поля опціональні):
    ```json
    {
      "pct": 100,
      "outMint": "So11111111111111111111111111111111111111112",
      "slippageBps": 100,
      "dynamicSlippage": true
    }
    ```
### Main логіка для закриття всіх
- `POST /pool/:address/exit-selected-and-sell`
  - Закриває перелік позицій по конкретному пулу і продає залишки в `outMint`.
  - Body:
    ```json
    {
      "positions": ["<positionPk>", "<positionPk2>"],
      "pct": 100,
      "outMint": "So11111111111111111111111111111111111111112",
      "slippageBps": 100,
      "dynamicSlippage": true
    }
    ```

- `POST /api/register-position`
  - Ручна реєстрація відповідності позиція → пул для локального ін‑меморі реєстру.
  - Body:
    ```json
    { "walletAddress": "<ownerPk>", "poolAddress": "<poolPk>", "positionPublicKey": "<posPk>" }
    ```

- `GET /api/lookup?position=<posPk>`
  - Повертає `{ poolAddress }` для позиції з локального реєстру.

### Як це працює (коротко)
- Сервіс підʼєднується до Solana RPC (`SOLANA_RPC_URL`).
- Гаманець береться з `.env` і підписує транзакції.
- Введення: при `enter-*` частина SOL за `ratio` свопиться у токен через Jupiter, решта обгортається у WSOL; далі створюються позиції DLMM за заданою стратегією та діапазонами.
- Вихід: `removeLiquidity` через DLMM SDK; залишки X/Y свопляться у `outMint` через Jupiter.

### CLI приклад (one‑sided X)
```bash
cd node_helper
npx ts-node scripts/add_via_sdk.ts <POOL_ADDRESS?> <AMOUNT_UI?> <BINS_SPAN?>
```
- Якщо аргументи не вказані, можна задати через `.env`: `POOL`, `AMOUNT_UI`.

### Розробка
- Dev‑запуск: `npm run dev` у `node_helper` (tsx watch)
- Типи/збірка: `npm run build`

### Посилання та документація
- Офіційний SDK: `https://github.com/MeteoraAg/dlmm-sdk`
- NPM: `https://www.npmjs.com/package/@meteora-ag/dlmm`
- Файл `docs/meteora_sdk.txt` — корисні фрагменти з прикладами викликів SDK




