import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface TownStations {
  town: string;
  ids: string[];
}

export interface CityStations {
  city: string;
  towns: TownStations[];
}

/** Where the menu sits, measured from the field as it opens. */
interface Place {
  left: number;
  top?: number;
  bottom?: number;
  height: number;
  /** One column's width: three always fit on the screen. */
  column: number;
}

/** Between the field and the menu, and between the menu and the screen's edge. */
const GAP = 6;
const MARGIN = 8;
const MAX_HEIGHT = 340;
const MAX_COLUMN = 150;

const townOf = (tree: CityStations[], id: string) => {
  for (const { city, towns } of tree) {
    const town = towns.find((t) => t.ids.includes(id));
    if (town) return { city, ...town };
  }
  return null;
};

/**
 * Under the field, or over it when there is more room there. Its left edge
 * is the field's, moved left where three columns would run off the screen,
 * so the columns opening on the right never shift the menu.
 */
function placeBy(field: HTMLElement): Place {
  const at = field.getBoundingClientRect();
  const column = Math.min(MAX_COLUMN, Math.floor((innerWidth - 2 * MARGIN - 2) / 3));
  const left = Math.max(MARGIN, Math.min(at.left, innerWidth - MARGIN - 3 * column - 2));
  const below = innerHeight - at.bottom - GAP - MARGIN;
  const above = at.top - GAP - MARGIN;
  return below >= Math.min(MAX_HEIGHT, 240) || below >= above
    ? { left, top: at.bottom + GAP, height: Math.min(MAX_HEIGHT, below), column }
    : { left, bottom: innerHeight - at.top + GAP, height: Math.min(MAX_HEIGHT, above), column };
}

/**
 * The station, from a cascading menu: the cities; beside the city picked, its
 * towns; beside the town picked, only where a town has several, its stations.
 * A town with one station is that station, chosen as soon as the town is.
 */
export function StationPicker({
  tree,
  value,
  onPick,
}: {
  tree: CityStations[];
  value: string;
  onPick: (id: string) => void;
}) {
  const [place, setPlace] = useState<Place | null>(null);
  const field = useRef<HTMLButtonElement>(null);

  if (!tree.length) {
    return (
      <div className="settings-row">
        <span className="settings-label">測站清單載入中，請稍後再開啟設定</span>
      </div>
    );
  }

  const here = townOf(tree, value);
  const path = here ? [here.city, here.town, ...(here.ids.length > 1 ? [value] : [])] : [];
  const close = (refocus: boolean) => {
    setPlace(null);
    if (refocus) field.current?.focus();
  };

  return (
    <div className="settings-row station-row">
      <span className="settings-label">測站</span>
      <button
        ref={field}
        type="button"
        className="station-field"
        aria-haspopup="dialog"
        aria-expanded={!!place}
        onClick={(event) => setPlace(place ? null : placeBy(event.currentTarget))}
      >
        <span>{path.length ? path.join(" › ") : "請選擇"}</span>
        <ChevronDown aria-hidden />
      </button>
      {place && (
        <StationMenu
          field={field}
          place={place}
          tree={tree}
          value={value}
          onPick={(id) => {
            close(true);
            if (id !== value) onPick(id);
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

/**
 * Opens on the path of the station in use. Portalled to <body>, above the
 * web's settings modal, so the scrolling page cannot clip it. Esc, Tab, a
 * click or a scroll outside it, or a change of the window's width close it,
 * and nothing else: the settings stay open.
 */
function StationMenu({
  field,
  place,
  tree,
  value,
  onPick,
  onClose,
}: {
  field: RefObject<HTMLButtonElement | null>;
  place: Place;
  tree: CityStations[];
  value: string;
  onPick: (id: string) => void;
  onClose: (refocus: boolean) => void;
}) {
  const here = townOf(tree, value);
  const [city, setCity] = useState(here?.city ?? null);
  const [town, setTown] = useState(here && here.ids.length > 1 ? here.town : null);
  const menu = useRef<HTMLDivElement>(null);
  /** The column to move focus into once it is drawn (arrow keys). */
  const focusNext = useRef<number | null>(null);

  const towns = tree.find((c) => c.city === city)?.towns ?? [];
  const ids = towns.find((t) => t.town === town)?.ids ?? [];

  const items = (col: number) => [
    ...(menu.current?.querySelectorAll<HTMLButtonElement>(`button[data-col="${col}"]`) ?? []),
  ];

  // On opening: the station in use, and each column's open item, in sight,
  // and focus on the deepest of them, for the keyboard.
  useLayoutEffect(() => {
    const marked = menu.current?.querySelectorAll<HTMLElement>("[aria-current='true'], [aria-expanded='true']");
    marked?.forEach((item) => item.scrollIntoView({ block: "nearest" }));
    (marked?.[marked.length - 1] ?? menu.current?.querySelector("button"))?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (focusNext.current === null) return;
    const col = focusNext.current;
    focusNext.current = null;
    items(col)[0]?.focus();
  });

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (!!menu.current?.contains(target) || !!field.current?.contains(target));
    // A press outside only closes the menu, as Esc does: stopped before the
    // web's settings modal, which closes on a mousedown outside its panel.
    // Mousedown, then, which a tap sends as well: closing on pointerdown
    // would take this listener away before the modal's event arrives.
    const onPress = (event: MouseEvent) => {
      if (inside(event.target)) return;
      event.stopPropagation();
      onClose(false);
    };
    const onScroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) onClose(false);
    };
    // A phone's address bar showing or hiding changes only the height.
    const width = innerWidth;
    const onResize = () => {
      if (innerWidth !== width) onClose(false);
    };
    const onKey = (event: KeyboardEvent) => {
      // Tab leaves from the field, on to whatever follows it.
      if (event.key === "Tab" && menu.current?.contains(event.target as Node)) onClose(true);
      if (event.key !== "Escape") return;
      // Stopped here, in the capture phase: the web's settings modal closes
      // on Esc as well.
      event.stopPropagation();
      event.preventDefault();
      onClose(true);
    };
    document.addEventListener("mousedown", onPress, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPress, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [field, onClose]);

  const pickCity = (next: string) => {
    if (next === city) return;
    setCity(next);
    setTown(null);
  };
  const pickTown = (next: TownStations) => {
    if (next.ids.length === 1) return onPick(next.ids[0]);
    setTown(next.town);
  };

  // Up and down within a column; right into the next, opening the item;
  // left back to the column before.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-col]");
    if (!item) return;
    const col = Number(item.dataset.col);
    const column = items(col);
    const i = column.indexOf(item);
    const expanded = item.getAttribute("aria-expanded");
    if (event.key === "ArrowDown") column[Math.min(i + 1, column.length - 1)]?.focus();
    else if (event.key === "ArrowUp") column[Math.max(i - 1, 0)]?.focus();
    else if (event.key === "Home") column[0]?.focus();
    else if (event.key === "End") column.at(-1)?.focus();
    else if (event.key === "ArrowRight" && expanded === "true") {
      const next = items(col + 1);
      (next.find((b) => b.getAttribute("aria-current") === "true") ?? next[0])?.focus();
    } else if (event.key === "ArrowRight" && expanded === "false") {
      focusNext.current = col + 1;
      item.click();
    } else if (event.key === "ArrowLeft" && col > 0) {
      const back = items(col - 1);
      (back.find((b) => b.getAttribute("aria-expanded") === "true") ?? back[0])?.focus();
    } else return;
    event.preventDefault();
  };

  return createPortal(
    <div
      ref={menu}
      className="station-menu"
      role="dialog"
      aria-label="選擇測站"
      style={
        {
          left: place.left,
          top: place.top,
          bottom: place.bottom,
          maxHeight: place.height,
          "--station-column": `${place.column}px`,
        } as React.CSSProperties
      }
      onKeyDown={onKeyDown}
    >
      <div className="station-menu-column" role="group" aria-label="縣市">
        <h3>縣市</h3>
        {tree.map((c) => (
          <button
            key={c.city}
            type="button"
            data-col={0}
            className={c.city === city ? "is-open" : undefined}
            aria-expanded={c.city === city}
            aria-current={c.city === here?.city}
            onClick={() => pickCity(c.city)}
          >
            <span>{c.city}</span>
            <ChevronRight aria-hidden />
          </button>
        ))}
      </div>
      {city && (
        <div className="station-menu-column" role="group" aria-label="鄉鎮市區">
          <h3>鄉鎮市區</h3>
          {towns.map((t) => {
            const more = t.ids.length > 1;
            return (
              <button
                key={t.town}
                type="button"
                data-col={1}
                className={t.town === town ? "is-open" : undefined}
                aria-expanded={more ? t.town === town : undefined}
                aria-current={city === here?.city && t.town === here.town}
                onClick={() => pickTown(t)}
              >
                <span>{t.town}</span>
                {more && (
                  <small>
                    {t.ids.length} 站
                    <ChevronRight aria-hidden />
                  </small>
                )}
              </button>
            );
          })}
        </div>
      )}
      {ids.length > 1 && (
        <div className="station-menu-column" role="group" aria-label="測站">
          <h3>測站</h3>
          {ids.map((id) => (
            <button key={id} type="button" data-col={2} aria-current={id === value} onClick={() => onPick(id)}>
              <span>{id}</span>
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
