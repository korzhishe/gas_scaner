# АЗС Краснодар

Статический сайт для GitHub Pages: карта заправок Краснодара, статус работы, наличие топлива, цены и дорожная нагрузка рядом с каждой АЗС.

## Что внутри

- `index.html`, `styles.css`, `app.js` - интерфейс без сборщика.
- `data/stations.json` - текущие данные, которые читает сайт.
- `collector/server.py` - собственный источник данных на SQLite.
- `collect.html` - форма оператора для обновления статуса, цен, наличия и пробок.
- `scripts/import-open-sources.mjs` - импорт цен из открытых источников, сейчас из RUSSIABASE.
- `scripts/import-osm-opening-hours.mjs` - импорт расписаний из OpenStreetMap `opening_hours` и расчет `open/closed` на текущее время Краснодара.
- `scripts/import-benzup.mjs` - импорт АЗС и цен из Benzup API в collector.
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

## Импорт из открытых источников

Основной бесплатный источник цен сейчас - публичные страницы RUSSIABASE по Краснодару. Скрипт читает SSR JSON из страниц вида `https://russiabase.ru/prices?brand=119&city=154778`, импортирует координаты, адреса и цены в collector.

Проверка без записи:

```bash
scripts/start-open-source-sync.sh --dry-run
```

Импорт в collector:

```bash
scripts/start-open-source-sync.sh
```

По умолчанию импортируются бренды `Газпромнефть`, `Лукойл`, `Роснефть`, `PNB`, `Teboil`, `RUSOIL`, `Irbis`, `КТК`. Бренды без открытой страницы по Краснодару пропускаются.

Текущий сервер уже настроен на обновление каждые 30 минут:

```cron
*/30 * * * * cd /home/deploy/projects/gas_scaner && scripts/start-open-source-sync.sh >> /tmp/gas_scaner_open_sources.log 2>&1
```

Открытые источники цен обычно не знают текущий режим работы АЗС, поэтому импорт цен не меняет `status` и `openUntil`. Статус работы обновляется отдельным импортом расписаний.

## Импорт расписаний из OpenStreetMap

Для статуса `Открыта` / `Закрыта` используется открытое поле OpenStreetMap `opening_hours`. Скрипт берет все `amenity=fuel` в границах Краснодара через Overpass API, сопоставляет их с АЗС collector по координатам, бренду и названию, затем считает статус по часовому поясу `Europe/Moscow`.

Проверка без записи:

```bash
scripts/start-osm-hours-sync.sh --dry-run
```

Импорт в collector:

```bash
scripts/start-osm-hours-sync.sh
```

Переменные настройки:

- `OVERPASS_URL` - по умолчанию `https://overpass-api.de/api/interpreter`.
- `OSM_BOUNDS` - границы поиска `minLat,minLng,maxLat,maxLng`, по умолчанию `44.90,38.75,45.20,39.20`.
- `OSM_MATCH_RADIUS_M` - радиус сопоставления с АЗС collector, по умолчанию `220`.
- `OSM_TIME_ZONE` - по умолчанию `Europe/Moscow`.

Текущий сервер уже настроен на пересчет расписаний каждые 10 минут:

```cron
*/10 * * * * cd /home/deploy/projects/gas_scaner && scripts/start-osm-hours-sync.sh >> /tmp/gas_scaner_osm_hours.log 2>&1
```

Если для станции в OSM нет `opening_hours`, сайт показывает `Статус неизвестен` и `График не указан`, а не считает такую АЗС закрытой.

## Импорт из Benzup

Benzup Retail API использует `https://api.omt-consult.ru` и bearer-токен. Импорт по умолчанию читает `GET /v2/stations`, фильтрует Краснодар по координатам или адресу и отправляет найденные АЗС в collector.

Добавьте токен в локальный `.collector.env`:

```bash
BENZUP_TOKEN=your-benzup-token
COLLECTOR_URL=http://127.0.0.1:8090
```

Проверка без записи:

```bash
scripts/start-benzup-sync.sh --dry-run --save-raw /tmp/benzup-stations.json
```

Импорт в collector:

```bash
scripts/start-benzup-sync.sh
```

Переменные настройки:

- `BENZUP_BASE_URL` - по умолчанию `https://api.omt-consult.ru`.
- `BENZUP_ENDPOINT` - по умолчанию `/v2/stations`.
- `BENZUP_PRODUCTS_ENDPOINT` - по умолчанию `/v2/products`.
- `BENZUP_CITY` - по умолчанию `Краснодар`.
- `BENZUP_BOUNDS` - границы фильтра `minLat,minLng,maxLat,maxLng`, по умолчанию `44.92,38.78,45.18,39.18`.

Cron для обновления каждые 30 минут:

```cron
*/30 * * * * cd /home/deploy/projects/gas_scaner && scripts/start-benzup-sync.sh >> /tmp/gas_scaner_benzup.log 2>&1
```

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
