# АЗС Краснодар

Статический сайт для GitHub Pages: карта заправок Краснодара, статус работы, наличие топлива, цены и дорожная нагрузка рядом с каждой АЗС.

## Что внутри

- `index.html`, `styles.css`, `app.js` - интерфейс без сборщика.
- `data/stations.json` - текущие данные, которые читает сайт.
- `collector/server.py` - собственный источник данных на SQLite.
- `collect.html` - форма оператора для обновления статуса, цен, наличия и пробок.
- `scripts/import-open-sources.mjs` - импорт цен из открытых источников, сейчас из RUSSIABASE.
- `scripts/import-osm-opening-hours.mjs` - импорт расписаний из OpenStreetMap `opening_hours` и расчет `open/closed` на текущее время Краснодара.
- `scripts/import-2gis-stations.mjs` - основной импорт каталога АЗС из 2ГИС в радиусе 40 км.
- `scripts/import-2gis-opening-hours.mjs` - импорт расписаний из 2ГИС. Первый запуск сопоставляет АЗС с id 2ГИС, последующие запуски обновляют расписания пачкой через `items/byid`.
- `scripts/import-public-signals.mjs` - мониторинг публичных Telegram/RSS-источников по свежим сообщениям про бензин, очереди и закрытые АЗС.
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
- `GET /api/signals` - свежие публичные сигналы о дефиците, очередях и наличии топлива.
- `POST /api/signals` - запись найденного сигнала из публичного источника.
- `POST /api/prune` - удаление устаревших станций по списку id, используется импортом 2ГИС после успешного обновления каталога.
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

Основной бесплатный источник цен сейчас - публичные страницы RUSSIABASE по Краснодару. Скрипт читает SSR JSON из страниц вида `https://russiabase.ru/prices?brand=119&city=154778`, находит ближайшую АЗС из 2ГИС и обновляет цены в этой карточке.

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

## Основной каталог 2ГИС

2ГИС используется как основной источник списка АЗС, координат, адресов, расписаний и паспортных типов топлива. Скрипт обходит радиус 40 км вокруг центра Краснодара сеткой точек, потому что один поисковый запрос 2ГИС ограничен первыми страницами выдачи.

Ключ хранится только на сервере в `.collector.env`:

```bash
DGIS_API_KEY=your-2gis-api-key
```

Проверка без записи:

```bash
scripts/start-2gis-stations-sync.sh --dry-run --prune-other-sources
```

Импорт в collector:

```bash
scripts/start-2gis-stations-sync.sh --prune-other-sources
```

Опция `--prune-other-sources` удаляет старые `russiabase-*` и демо-станции после успешного импорта, чтобы 2ГИС оставался главным каталогом, а RUSSIABASE только обновлял цены.

Переменные настройки:

- `DGIS_CENTER` - центр поиска `lat,lng`, по умолчанию `45.0355,38.9753`.
- `DGIS_RADIUS_M` - радиус поиска, по умолчанию `40000`.
- `DGIS_GRID_STEP_M` - шаг сетки, по умолчанию `8000`.
- `DGIS_CELL_RADIUS_M` - радиус поиска вокруг каждой точки сетки, по умолчанию `6200`.
- `DGIS_RUBRIC_ID` - рубрика `Заправочные станции`, по умолчанию `18547`.
- `DGIS_PRICE_MATCH_RADIUS_M` - радиус сопоставления цен RUSSIABASE с карточкой 2ГИС, по умолчанию `500`.

Текущий сервер обновляет полный каталог 2ГИС раз в неделю:

```cron
31 4 * * 0 cd /home/deploy/projects/gas_scaner && scripts/start-2gis-stations-sync.sh --prune-other-sources >> /tmp/gas_scaner_2gis_stations.log 2>&1
```

2ГИС через официальный API отдает агрегаты отзывов (`rating`, количество отзывов), но не тексты свежих отзывов с датами. Поэтому автоматическая логика “по отзывам сегодня/вчера понять, есть ли бензин” сейчас не включена: для этого нужен отдельный официальный источник отзывов или разрешенный API с текстами и датами.

## Мониторинг публичных сигналов

Для оперативной ситуации с дефицитом топлива collector дополнительно собирает свежие публичные сообщения из Telegram web-лент и RSS. Парсер ищет сообщения про бензин, АЗС, заправки, очереди, закрытия, привоз топлива и оставляет только свежие сигналы за последние 48 часов.

Проверка без записи:

```bash
scripts/start-public-signals-sync.sh --dry-run
```

Импорт в collector:

```bash
scripts/start-public-signals-sync.sh
```

По умолчанию мониторятся публичные Telegram-ленты:

- `krd_tipich_ru` - Типичный Краснодар
- `krddtp1` - КРДДТП
- `KrasnodarUMR` - Краснодар ЮМР
- `chp_krd` - ЧП Краснодар
- `kuban24` - Кубань 24
- `krd_chp` - Новости Краснодара

Дополнительные публичные Telegram-каналы можно добавить через `.collector.env`:

```bash
SIGNAL_TELEGRAM_CHANNELS=channel:name,another_channel:Название
```

RSS-ленты сайтов или форумов можно добавить так:

```bash
SIGNAL_RSS_FEEDS=https://example.com/rss|Название источника,https://forum.example.com/rss|Форум
```

Текущий сервер обновляет публичные сигналы каждые 10 минут:

```cron
*/10 * * * * cd /home/deploy/projects/gas_scaner && scripts/start-public-signals-sync.sh >> /tmp/gas_scaner_public_signals.log 2>&1
```

Приватные чаты и закрытые форумы не парсятся без разрешенного доступа. Если есть официальный API, RSS, публичная web-страница или экспорт с согласием участников, их можно подключить как новый источник.

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

## Импорт расписаний из 2ГИС

2ГИС также используется для обновления расписаний уже импортированных станций. Для станций с id вида `2gis-<id>` обновитель берет id прямо из `stationId`; файл соответствий нужен только для старых не-2ГИС карточек.

Добавьте ключ:

```bash
DGIS_API_KEY=your-2gis-api-key
```

Первый запуск с поиском соответствий:

```bash
scripts/start-2gis-hours-sync.sh --refresh-matches
```

Он создаст `data/2gis-matches.json` с соответствиями `stationId -> 2gis id`. После этого обычное обновление делает один запрос `items/byid` для всех сопоставленных АЗС:

```bash
scripts/start-2gis-hours-sync.sh
```

Проверка без записи:

```bash
scripts/start-2gis-hours-sync.sh --dry-run
```

Переменные настройки:

- `DGIS_BASE_URL` - по умолчанию `https://catalog.api.2gis.com/3.0`.
- `DGIS_RUBRIC_ID` - рубрика `Заправочные станции`, по умолчанию `18547`.
- `DGIS_MATCH_RADIUS_M` - радиус первичного сопоставления, по умолчанию `450`.
- `DGIS_MATCH_FILE` - файл соответствий, по умолчанию `data/2gis-matches.json`.
- `DGIS_TIME_ZONE` - по умолчанию `Europe/Moscow`.

На текущем сервере расписания 2ГИС обновляются раз в 6 часов, чтобы не сжигать лимит ключа:

```cron
17 */6 * * * cd /home/deploy/projects/gas_scaner && scripts/start-2gis-hours-sync.sh >> /tmp/gas_scaner_2gis_hours.log 2>&1
```

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
