# АЗС Краснодар

Статический сайт для GitHub Pages: карта заправок Краснодара, статус работы, наличие топлива, цены и дорожная нагрузка рядом с каждой АЗС.

## Что внутри

- `index.html`, `styles.css`, `app.js` - интерфейс без сборщика.
- `data/stations.json` - текущие данные, которые читает сайт.
- `collector/server.py` - собственный источник данных на SQLite.
- `collect.html` - форма оператора для обновления статуса, цен, наличия и пробок.
- `scripts/update-stations.mjs` - обновление `data/stations.json` из внешнего JSON API.
- `.github/workflows/pages.yml` - деплой на GitHub Pages.
- `.github/workflows/update-data.yml` - плановое обновление данных каждые 30 минут.

## Формат данных

Сайт ожидает JSON такого вида:

```json
{
  "generatedAt": "2026-06-30T07:00:00Z",
  "sourceLabel": "Live data source",
  "stations": [
    {
      "id": "krd-001",
      "name": "АЗС Центр",
      "brand": "Лукойл",
      "district": "Центральный",
      "address": "ул. Красная, 176, Краснодар",
      "coords": { "lat": 45.0428, "lng": 38.9754 },
      "status": "open",
      "openUntil": "24/7",
      "updatedAt": "2026-06-30T06:55:00Z",
      "traffic": { "score": 7, "label": "Плотно", "delayMin": 14 },
      "fuels": [
        { "type": "АИ-92", "price": 57.9, "available": true },
        { "type": "АИ-95", "price": 62.4, "available": true }
      ],
      "services": ["магазин", "кофе"]
    }
  ]
}
```

`data/stations.json` содержит стартовые записи. Для реального мониторинга можно использовать собственный collector API или внешний провайдер, который отдает JSON в этом формате.

## Собственный collector API

Collector хранит данные в SQLite и отдает JSON, совместимый с сайтом:

```bash
COLLECTOR_TOKEN=change-me python3 collector/server.py
```

По умолчанию API слушает `http://0.0.0.0:8090`.

Основные endpoint:

- `GET /api/stations` - актуальный JSON для сайта и GitHub Actions.
- `POST /api/reports` - обновление одной АЗС. Если задан `COLLECTOR_TOKEN`, передайте `Authorization: Bearer <token>`.
- `GET /api/reports?stationId=krd-001` - последние отчеты.

Пример отчета:

```json
{
  "stationId": "krd-001",
  "status": "open",
  "openUntil": "24/7",
  "source": "operator-form",
  "traffic": { "score": 4, "label": "Умеренно", "delayMin": 6 },
  "fuels": [
    { "type": "АИ-92", "price": 57.9, "available": true },
    { "type": "АИ-95", "price": 62.4, "available": true }
  ]
}
```

Форма оператора доступна в `collect.html`. На сервере с текущей конфигурацией это `http://89.167.119.100:8080/collect.html`.

## Подключение live-данных

1. Создайте публичный или закрытый endpoint, который возвращает JSON в формате выше. Собственный collector уже подходит: `/api/stations`.
2. В репозитории GitHub задайте `DATA_SOURCE_URL` в `Settings -> Secrets and variables -> Actions`.
3. Если endpoint требует авторизацию, добавьте `DATA_SOURCE_TOKEN`.
4. Запустите workflow `Update station data` вручную или дождитесь расписания.

GitHub Pages не умеет хранить приватные серверные ключи на клиенте, поэтому сбор данных лучше делать через GitHub Actions или отдельный backend/proxy.

## Локальный запуск

```bash
python3 -m http.server 8080
```

Откройте `http://localhost:8080`.

## Публикация

После пуша в ветку `main` workflow `Deploy to GitHub Pages` публикует содержимое репозитория на GitHub Pages. В настройках репозитория GitHub Pages должен быть выбран источник `GitHub Actions`.
