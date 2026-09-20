"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type FilterField = {
  /** The query-string key this badge owns. */
  key: string;
  label: string;
  placeholder: string;
  /** Offered in a datalist — typed values are still allowed, so a new IP is not locked out. */
  suggestions?: string[];
  /**
   * A friendlier badge label for a stored value — a session id shown as its name.
   *
   * Data, not a function, and that is not a style choice: this component is a client component and
   * its props are built on the server, so a callback here crashes the page with "Functions cannot
   * be passed directly to Client Components". A lookup serialises; a closure does not.
   */
  labels?: Record<string, string>;
  /** Long values are clipped in the badge. `keep` is the end worth reading. */
  clip?: { keep: "start" | "end"; max: number };
};

/** What a badge shows for a chosen value: a friendly label if there is one, else clipped. */
function display(field: FilterField, value: string): string {
  const label = field.labels?.[value];
  if (label) return label;
  const max = field.clip?.max;
  if (!max || value.length <= max) return value;
  // A route is identified by its tail and a user agent by its head, so which end is kept matters.
  return field.clip?.keep === "start" ? `${value.slice(0, max - 1)}…` : `…${value.slice(-(max - 1))}`;
}

/**
 * The filter bar.
 *
 * Each badge owns one query-string key, and clicking it opens a small popover to type or pick a
 * value. A badge rather than a row of always-open inputs because the bar carries seven filters and
 * six of them are usually empty: seven empty text boxes is a form, and nobody reads a form to look
 * at a log.
 *
 * **Filters live in the URL, and that is the whole point.** The panel, the pager and the list all
 * read the same query string, so a narrowed view can be linked, reloaded, and gone back from — and
 * "the 429s from this address yesterday" is a thing you can send to somebody rather than a thing
 * you describe to them.
 *
 * This is the one client component in the page. The list and the detail panel stay on the server so
 * bodies keep going through the build-time highlighter; only choosing a filter needs a keystroke.
 */
export function AuditFilters({
  fields,
  toggles,
}: {
  fields: FilterField[];
  /** Filters with no value to enter — "errors only" is on or off. */
  toggles: { active: boolean; key: string; label: string; value: string }[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);

  /**
   * Navigate with one key changed.
   *
   * `page` and `selected` are always dropped: page 4 of the old filter is rarely page 4 of the new
   * one, and a row selected under the previous filter may not be in the new result at all — leaving
   * either behind produces an empty list or a panel showing a row you can no longer see.
   */
  const apply = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    next.delete("selected");
    setOpen(null);
    const q = next.toString();
    router.push(`/audit${q ? `?${q}` : ""}`);
  };

  return (
    <div className="mt-8 flex flex-wrap items-center gap-2">
      {toggles.map((t) => (
        <button
          className={badgeClass(t.active)}
          key={t.key + t.value}
          onClick={() => apply(t.key, t.active ? null : t.value)}
          type="button"
        >
          {t.label}
        </button>
      ))}

      {fields.map((f) => {
        const value = params.get(f.key);
        return (
          <div className="relative" key={f.key}>
            <button className={badgeClass(Boolean(value))} onClick={() => setOpen(open === f.key ? null : f.key)} type="button">
              {value ? (
                <>
                  <span className="text-[var(--muted-foreground)]">{f.label}</span>{" "}
                  <span className="font-[560]">{display(f, value)}</span>
                </>
              ) : (
                f.label
              )}
              {value ? (
                /*
                 * A span, not a nested button — a button inside a button is invalid HTML and the
                 * inner one stops receiving clicks in some browsers. `stopPropagation` keeps the
                 * clear from also opening the popover behind it.
                 */
                <span
                  aria-label={`Clear ${f.label} filter`}
                  className="ml-2 inline-block text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    apply(f.key, null);
                  }}
                  role="button"
                  tabIndex={-1}
                >
                  ×
                </span>
              ) : null}
            </button>

            {open === f.key ? (
              <ValuePopover
                field={f}
                initial={value ?? ""}
                onCancel={() => setOpen(null)}
                onSubmit={(v) => apply(f.key, v.trim() || null)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const badgeClass = (on: boolean) =>
  "rounded-[var(--radius)] border px-3 py-1.5 text-[0.8rem] transition-colors " +
  (on
    ? "border-[var(--foreground)] text-[var(--foreground)]"
    : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]");

/** The little panel a badge opens. One input, its suggestions, and the two ways out. */
function ValuePopover({
  field,
  initial,
  onCancel,
  onSubmit,
}: {
  field: FilterField;
  initial: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLDivElement>(null);
  const listId = `audit-filter-${field.key}`;

  /**
   * Escape closes it, and so does a click anywhere else.
   *
   * Without the outside click the only way out is the badge that opened it, which is a trap the
   * moment somebody opens a second badge and expects the first to close.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("keydown", onKey);
    // Deferred: the click that opened this popover is still propagating, and would close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onClick), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
      clearTimeout(t);
    };
  }, [onCancel]);

  return (
    <div
      className="absolute z-20 mt-2 w-[280px] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-3 shadow-[0_18px_40px_rgba(10,10,10,0.14)]"
      ref={ref}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
      >
        <label className="block text-[0.75rem] text-[var(--muted-foreground)]" htmlFor={listId}>
          {field.label}
        </label>
        <input
          // Autofocus is right here: the popover exists only to take one value.
          autoFocus
          className="mt-1.5 w-full rounded-[calc(var(--radius)-4px)] border border-[var(--input)] bg-[var(--background)] px-2.5 py-1.5 text-[0.85rem] outline-none focus:border-[var(--ring)]"
          id={listId}
          list={field.suggestions?.length ? `${listId}-options` : undefined}
          onChange={(e) => setValue(e.target.value)}
          placeholder={field.placeholder}
          value={value}
        />
        {field.suggestions?.length ? (
          <datalist id={`${listId}-options`}>
            {field.suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        ) : null}

        <div className="mt-2.5 flex items-center gap-2">
          <button className="btn btn-primary px-3 py-1 text-[0.8rem]" type="submit">
            Apply
          </button>
          <button
            className="text-[0.8rem] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
