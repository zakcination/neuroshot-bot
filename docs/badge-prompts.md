# Промпты для 17 значков достижений

Готовы к вставке в Higgsfield. Рендер делается вручную — см. «Как генерировать».

Куда класть результат: `public/img/badge-<id>.png`. Ничего в коде менять не нужно —
глиф рисуется всегда, а картинка накрывает его и удаляет по загрузке
(`badgeHtml` в `public/app.html`). Поэтому файлы можно добавлять по одному, и
набор никогда не выглядит недоделанным.

## Модель

**Nano Banana Pro.** Это литеральный предметный рендер — металл, фаска, блик; та
же категория, что продуктовая съёмка, а не стилизация. Soul Cinema заточен под
портрет, Flux уводит в иллюстративность и теряет материал.

Альтернатива, если захотите рисованный набор вместо «фотографии металла»:
**Flux 2**, тот же системный блок, добавить `illustrated, flat-shaded`.

## Главное: набор, а не 17 значков

Единственная вещь, которая губит такие наборы, — каждый значок промптится
отдельно, и в итоге у них разный угол света, разная толщина, разный масштаб
объекта в кадре. На стене это сразу читается как свалка.

Поэтому **системный блок ниже вставляется в каждый промпт дословно**, меняется
только строка сюжета и материала. Не переписывайте его «своими словами» ни в
одном из 17 — расхождение в одной формулировке даёт расхождение в картинке.

### Системный блок (дословно, во всех 17)

```
Premium 3D achievement medallion, heater-shield silhouette, centred frontal
view, orthographic — no perspective distortion, no tilt, no rotation. Single
soft key light from the upper left at 45 degrees, subtle cool fill from the
lower right, deep bevelled edges catching a thin specular rim. Product-render
quality, sharp micro-detail, shallow relief. Isolated on a fully transparent
background. Square composition, object centred and filling 62 percent of the
frame. No text, no letters, no numbers, no logos, no background scenery.
```

### Материал по тиру (одна строка, дословно)

- **bronze** — `Material: warm patinated bronze, darkened recesses, faint verdigris in the crevices.`
- **silver** — `Material: polished steel with a cold reflection, brushed core, mirror-bright bevel.`
- **gold** — `Material: deep antique gold, dark bevelled edges, warm inner glow, not yellow plastic.`

### Сборка промпта

```
<СИСТЕМНЫЙ БЛОК>
Subject in relief on the shield face: <СЮЖЕТ>.
<МАТЕРИАЛ ТИРА>
```

## Сюжеты

| id | Тир | Сюжет (подставить в `<СЮЖЕТ>`) |
|---|---|---|
| `first_render` | bronze | `a vintage camera body with a lens hood, three-quarter relief` |
| `ten_renders` | silver | `a coiled strip of 35mm film, perforations visible` |
| `fifty_renders` | gold | `a classical colonnade of five columns under a pediment` |
| `first_video` | silver | `a film clapperboard, arm raised open` |
| `first_text` | bronze | `a quill pen crossing an open inkwell` |
| `explorer` | silver | `a mariner's compass rose with a raised needle` |
| `polymath` | gold | `a fan of five different tools radiating from a central hub` |
| `stylist` | silver | `an artist's palette with three raised paint mounds and a brush` |
| `scenarist` | silver | `an open book with a ribbon marker falling across the pages` |
| `uploader` | bronze | `a framed photograph, the frame in raised relief, corner lifted` |
| `wordsmith` | bronze | `a four-pointed spark with two smaller sparks beside it` |
| `sharer` | bronze | `a broadcast antenna emitting three concentric arcs` |
| `first_purchase` | silver | `a perforated admission ticket, one corner torn` |
| `patron` | gold | `a five-point crown with raised jewel settings, no gems` |
| `inviter` | silver | `two clasped hands in shallow relief` |
| `circle` | gold | `five stylised figures joined in a ring, seen from above` |
| `level_3` | silver | `a triangle built from three interlocking facets, one raised higher` |

## Как генерировать

**Сначала один лист, потом поштучно.** Прогоните три штуки — по одной каждого
тира (`first_render` / `ten_renders` / `fifty_renders`) — и посмотрите их рядом.
Если угол света, толщина фаски и масштаб совпали, набор сойдётся; если нет,
правится системный блок, а не отдельный значок. Это дешевле, чем отрендерить 17
и обнаружить расхождение на стене.

Дальше — по одному, порядок значения не имеет.

**Проверка перед укладкой в репозиторий:**

- фон действительно прозрачный (а не белый квадрат);
- в кадре нет ни одной буквы и цифры — подпись под значком уже есть в
  интерфейсе и локализуется;
- объект не наклонён: приложение вращает значок само, и собственная перспектива
  картинки будет драться с этим вращением;
- 512×512, PNG.

## Чего не делаем

**Значки не генерируются из пользовательских фотографий.** Фото загружались
ради результата для самого человека; использовать их как оформление продукта —
другая цель, и она не покрыта опубликованной политикой конфиденциальности.

**Никаких реальных брендов, логотипов и монограмм** в сюжетах — по той же
причине, по которой они запрещены в Fashion-пресете.
