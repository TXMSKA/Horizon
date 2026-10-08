import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from 'react';
import { ArrowLeft, ArrowRight, CircleHelp, Plus, Search, SearchX, Ungroup } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import { GROUP_COLORS, LIGHT_THEMES, MARKETPLACE_THEMES } from './shared/api';
import type { BrowserCommand, GroupColor, Language, TabGroup, TabState } from './shared/api';
import { groupPaint, hexToHSV, hsvToHex } from './shared/group-colors';
import type { GroupPalette, HSV } from './shared/group-colors';
import { createGroupIconSearch } from './shared/group-icon-search';
import type { GroupIconSearch } from './shared/group-icon-search';
import { groupName } from './shared/tab-groups';
import { PopupAnchor } from './PopupAnchor';
import './tab-groups.css';

type Run = (command: BrowserCommand) => Promise<boolean>;
const PAGE = 8;
const colorLabels: Record<typeof GROUP_COLORS[number], CopyKey> = { success: 'colourGreen', info: 'colourBlue', primary: 'colourAmber', error: 'colourRed', warning: 'colourYellow', soft: 'groupColourMuted', title: 'neutral', dim: 'groupColourDim' };
const customColor = (color: string) => color.startsWith('#');
export function groupDisplayName(group: TabGroup, language: Language): string {
  return group.name.trim() || (customColor(group.color) ? text('groupCustomColourName', language).replace('{hex}', group.color) : text(colorLabels[group.color as keyof typeof colorLabels], language));
}
export function useGroupPalette(): GroupPalette {
  const read = (): GroupPalette => {
    const root = document.documentElement, style = getComputedStyle(root), id = root.dataset.theme ?? '', light = LIGHT_THEMES.includes(id);
    // Fjord shipped with Amber's group colours and keeps them; the later marketplace themes use their own.
    const own = id !== 'fjord' && (MARKETPLACE_THEMES as readonly string[]).includes(id);
    const theme = root.dataset.contrast === 'high' ? light ? 'contrast-light' : 'contrast-dark' : own ? id : light ? 'daylight' : 'amber';
    const value = (role: string) => style.getPropertyValue(`--palette-${theme}-${role}`).trim();
    return { chrome: value('chrome'), wash: value('wash'), colors: Object.fromEntries(GROUP_COLORS.map(color => [color, value(color)])) };
  };
  const [palette, setPalette] = useState(read);
  useLayoutEffect(() => {
    // applyTheme rewrites both attributes on every state push, so an unchanged palette keeps its identity.
    const observer = new MutationObserver(() => setPalette(previous => { const next = read(); return JSON.stringify(next) === JSON.stringify(previous) ? previous : next; }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-contrast'] });
    return () => observer.disconnect();
  }, []);
  return palette;
}
function useGroupPaint(ref: RefObject<HTMLElement | null>, color: string, palette: GroupPalette) {
  useLayoutEffect(() => { ref.current?.style.setProperty('--group-color', groupPaint(color, palette)); }, [ref, color, palette]);
}
const iconCache = new Map<string, LucideIcon>();
let iconImports: Promise<typeof import('lucide-react/dynamicIconImports').default> | undefined;
function GroupIcon({ name }: { name: string | null }) {
  const [loaded, setLoaded] = useState<{ name: string; icon: LucideIcon } | null>(null);
  useEffect(() => {
    if (!name || iconCache.has(name)) return;
    let current = true;
    iconImports ??= import('lucide-react/dynamicIconImports').then(module => module.default).catch(reason => { iconImports = undefined; throw reason; });
    void iconImports.then(imports => imports[name as keyof typeof imports]()).then(module => {
      iconCache.set(name, module.default); if (current) setLoaded({ name, icon: module.default });
    }).catch(() => { if (current) setLoaded({ name, icon: CircleHelp }); });
    return () => { current = false; };
  }, [name]);
  if (!name) return null;
  const Icon = iconCache.get(name) ?? (loaded?.name === name ? loaded.icon : null);
  return Icon ? <Icon aria-hidden="true" /> : <span className="group-icon-loading" aria-hidden="true" />;
}
export function GroupRun({ group, palette, language, children, editorId, editorOpener, run, onEdit }: {
  group: TabGroup; palette: GroupPalette; language: Language; children: ReactNode; editorId: string | null; editorOpener: RefObject<HTMLButtonElement | null>; run: Run; onEdit: (group: TabGroup, opener: HTMLButtonElement) => void;
}) {
  const ref = useRef<HTMLDivElement>(null), label = useRef<HTMLButtonElement>(null), tabs = useRef<HTMLDivElement>(null);
  const [displayed, setDisplayed] = useState(!group.folded), animation = useRef<Animation | null>(null), previous = useRef(group.folded);
  useGroupPaint(ref, group.color, palette);
  // A group created from the tab menu opens its editor before anything has told the editor which label to sit under.
  useLayoutEffect(() => {
    if (editorId !== group.id) return;
    editorOpener.current = label.current; label.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [editorId, editorOpener, group.id]);
  useLayoutEffect(() => {
    if (previous.current === group.folded) return;
    previous.current = group.folded;
    const element = tabs.current, running = animation.current;
    // Another click while the tabs are still moving turns the same motion around from where it is.
    if (running?.playState === 'running') { running.reverse(); return; }
    running?.cancel(); animation.current = null;
    if (!element || matchMedia('(prefers-reduced-motion: reduce)').matches) { setDisplayed(!group.folded); return; }
    setDisplayed(true);
    const style = getComputedStyle(element), shown = 'inset(0)', clipped = 'inset(0 100% 0 0)';
    const motion = element.animate({ clipPath: group.folded ? [shown, clipped] : [clipped, shown] }, { duration: Number.parseFloat(style.getPropertyValue('--duration-group-fold')), easing: style.getPropertyValue('--curve-group-fold').trim(), fill: 'both' });
    animation.current = motion;
    motion.onfinish = () => { if (animation.current === motion) setDisplayed(!previous.current); };
  }, [group.folded]);
  useEffect(() => () => animation.current?.cancel(), []);
  const name = groupDisplayName(group, language);
  return <div className="tab-group-run" ref={ref}>
    <button className="tab-group-label" ref={label} type="button" aria-label={text('tabGroup', language).replace('{name}', name)} title={name} aria-expanded={!group.folded} aria-controls={`group-tabs-${group.id}`} onClick={() => { void run({ type: 'set-tab-group-folded', id: group.id, folded: !group.folded }); }} onContextMenu={event => { event.preventDefault(); onEdit(group, event.currentTarget); }} onKeyDown={event => {
      if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); onEdit(group, event.currentTarget); }
    }}><span className="tab-group-label-surface"><GroupIcon name={group.icon} /><span>{name}</span></span></button>
    <div className="tab-group-tabs" id={`group-tabs-${group.id}`} ref={tabs} hidden={!displayed} inert={group.folded}>{children}</div>
  </div>;
}
function GroupMenuRow({ group, palette, language, onChoose }: { group: TabGroup; palette: GroupPalette; language: Language; onChoose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null), label = text('addTabToGroup', language).replace('{name}', groupDisplayName(group, language));
  useGroupPaint(ref, group.color, palette);
  return <button className="tab-group-menu-row" ref={ref} type="button" role="menuitem" tabIndex={-1} title={label} onClick={onChoose}><span className="tab-group-menu-mark" aria-hidden="true">{group.icon ? <GroupIcon name={group.icon} /> : <span className="tab-group-menu-dot" />}</span><span>{label}</span></button>;
}
export function TabGroupMenuItems({ tab, groups, palette, language, close, focusTab, run }: {
  tab: TabState; groups: readonly TabGroup[]; palette: GroupPalette; language: Language; close: (focus?: boolean) => void; focusTab: (id: string) => void; run: Run;
}) {
  // A tab that changes group is drawn inside another run, so its button is replaced and focus has to be put back after the move.
  const move = (command: BrowserCommand) => { close(); void run(command).then(done => { if (done) focusTab(tab.id); }); };
  const t = (key: CopyKey) => text(key, language);
  return <>
    <hr role="separator" />
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => { close(); void run({ type: 'create-tab-group', id: tab.id }); }}><Plus aria-hidden="true" /><span>{t('addTabToNewGroup')}</span></button>
    {groups.filter(group => group.id !== tab.groupId).map(group => <GroupMenuRow key={group.id} group={group} palette={palette} language={language} onChoose={() => move({ type: 'add-tab-to-group', id: tab.id, group: group.id })} />)}
    {tab.groupId && <button type="button" role="menuitem" tabIndex={-1} onClick={() => move({ type: 'remove-tab-from-group', id: tab.id })}><Ungroup aria-hidden="true" /><span>{t('removeTabFromGroup')}</span></button>}
  </>;
}
// A radio group chooses as focus moves, as native radios do; it returns -1 for any other key.
function nextRadio(event: KeyboardEvent, index: number, count: number): number {
  const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % count : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + count - 1) % count : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : -1;
  if (next >= 0) event.preventDefault();
  return next;
}
export function GroupEditor({ group, language, palette, opener, run, onDismiss }: {
  group: TabGroup; language: Language; palette: GroupPalette; opener: RefObject<HTMLButtonElement | null>; run: Run; onDismiss: (focus: boolean) => void;
}) {
  const t = (key: CopyKey) => text(key, language);
  const ref = useRef<HTMLDivElement>(null), nameRef = useRef<HTMLInputElement>(null), searchRef = useRef<HTMLInputElement>(null), customRef = useRef<HTMLButtonElement>(null), pickerRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(group.name), [nameInvalid, setNameInvalid] = useState(false), [saved, setSaved] = useState(false);
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(0), [focusIcon, setFocusIcon] = useState<string | null>(group.icon);
  const [searcher, setSearcher] = useState<GroupIconSearch | null>(null), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0), [pickerOpen, setPickerOpen] = useState(false);
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => { dismiss.current = onDismiss; });
  useGroupPaint(ref, group.color, palette);
  useLayoutEffect(() => { nameRef.current?.focus(); nameRef.current?.select(); }, []);
  useEffect(() => { const timer = window.setTimeout(() => { setSearch(query); setPage(0); }, 250); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => {
    let current = true; setFailed(false);
    // The tag tables are the only part of the search that is large, so they load when the editor opens.
    void Promise.all([import('./shared/group-icon-tags'), import('./shared/group-icon-spanish')]).then(([english, spanish]) => { if (current) setSearcher(() => createGroupIconSearch(english.GROUP_ICON_TAGS, spanish.GROUP_ICON_SPANISH)); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [retry]);
  useEffect(() => {
    const away = (event: Event) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !pickerRef.current?.contains(target) && !opener.current?.contains(target)) dismiss.current(false);
    };
    document.addEventListener('pointerdown', away); document.addEventListener('focusin', away);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('focusin', away); };
  }, [opener]);
  const results = useMemo(() => searcher?.(search) ?? [], [searcher, search]);
  const first = page * PAGE, choices = results.slice(first, first + PAGE), pending = !searcher && !failed || query !== search;
  const selected = choices.findIndex(icon => icon.name === group.icon), roving = choices.findIndex(icon => icon.name === focusIcon), tabbable = selected >= 0 ? selected : roving >= 0 ? roving : 0;
  const shown = search.trim(), count = t(shown ? results.length === 1 ? 'groupIconForOne' : 'groupIconsForMany' : 'groupIconsMany').replace('{count}', String(results.length)).replace('{query}', shown);
  const update = async (change: { name?: string; color?: GroupColor; icon?: string | null }) => { if (await run({ type: 'update-tab-group', id: group.id, ...change })) setSaved(true); };
  const showIcon = (icon: { name: string }, move: boolean) => {
    setFocusIcon(icon.name); void update({ icon: icon.name });
    if (move) requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-group-icon="${icon.name}"]`)?.focus());
  };
  const pickable = customColor(group.color) ? group.color : groupPaint(group.color, palette);
  const openPicker = () => { if (!customColor(group.color)) void update({ color: pickable }); setPickerOpen(true); };
  const radioColors: readonly GroupColor[] = [...GROUP_COLORS, pickable];
  const turnPage = (next: number) => {
    setPage(next);
    const icon = results[next * PAGE];
    if (icon) { setFocusIcon(icon.name); requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-group-icon="${icon.name}"]`)?.focus()); }
  };
  // The popups are mounted after the chrome, so leaving one by Tab would land at the start of the document; at an edge, Tab hands focus back to the opener instead.
  // The board measures its 6px from the label's visible surface, which is 26px centred in the 32px label target, so 3px of that gap already lie below the surface.
  return <PopupAnchor opener={opener} align="start" gap={3}><div className="group-editor" id="group-editor" ref={ref} role="dialog" aria-label={t('editTabGroup')} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (pickerOpen) { setPickerOpen(false); customRef.current?.focus(); } else onDismiss(true); }
    else if (event.key === 'Tab') { const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled):not([tabindex="-1"])')]; if (document.activeElement === (event.shiftKey ? stops[0] : stops.at(-1))) { event.preventDefault(); onDismiss(true); } }
  }}>
    <div className="group-editor-section"><label htmlFor="group-name">{t('groupName')}</label><input id="group-name" className="group-field" ref={nameRef} type="text" autoComplete="off" spellCheck={false} placeholder={t('groupNamePlaceholder')} maxLength={80} value={name} aria-invalid={nameInvalid} aria-describedby={nameInvalid ? 'group-name-error' : undefined} onChange={event => {
      const value = event.target.value, invalid = !groupName(value); setName(value); setNameInvalid(invalid); if (!invalid) void update({ name: value });
    }} />{nameInvalid && <p className="group-field-error" id="group-name-error" role="alert">{t('groupNameInvalid')}</p>}</div>
    <div className="group-editor-section"><span className="group-field-label" id="group-colour-label">{t('groupColour')}</span><div className="group-swatches" role="radiogroup" aria-labelledby="group-colour-label">{radioColors.map((color, index) => {
      const custom = index === GROUP_COLORS.length, checked = custom ? customColor(group.color) : group.color === color;
      return <GroupSwatch key={custom ? 'custom' : color} color={color} palette={palette} custom={custom} checked={checked} refObject={custom ? customRef : undefined} label={custom ? t('groupCustomColour') : t(colorLabels[color as keyof typeof colorLabels])} expanded={custom ? pickerOpen : undefined} onChoose={() => { if (custom) openPicker(); else { setPickerOpen(false); void update({ color }); } }} onKeyDown={event => {
        const next = nextRadio(event, index, radioColors.length);
        if (next < 0) return;
        // Choosing the custom swatch rewrites the colour and opens the picker, so arrows only move focus to it; Enter, Space or a click chooses it.
        if (next !== GROUP_COLORS.length) { setPickerOpen(false); void update({ color: radioColors[next]! }); }
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus();
      }} />;
    })}</div></div>
    <div className="group-editor-section"><label id="group-icon-label" htmlFor="group-icon-search">{t('groupIcon')}</label>
      <div className="group-search-field"><Search aria-hidden="true" /><input id="group-icon-search" type="search" ref={searchRef} spellCheck={false} autoComplete="off" maxLength={128} placeholder={t('searchGroupIcons')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); ref.current?.querySelector<HTMLButtonElement>('.group-icon-choice[tabindex="0"]')?.focus(); } }} /></div>
      {failed ? <div className="group-icon-empty"><p role="status">{t('groupIconsLoadFailed')}</p><button type="button" className="group-inline-action" onClick={() => { setRetry(value => value + 1); searchRef.current?.focus(); }}>{t('retry')}</button></div>
        : searcher && !results.length ? <div className="group-icon-empty"><p role="status"><SearchX aria-hidden="true" />{t('groupIconsEmpty')}</p><button type="button" className="group-inline-action" onClick={() => { setQuery(''); setSearch(''); setPage(0); searchRef.current?.focus(); }}>{t('clearFilter')}</button></div>
        : <>
          <div className="group-icon-results" role="radiogroup" aria-labelledby="group-icon-label" aria-busy={pending}>{!searcher ? Array.from({ length: PAGE }, (_, index) => <span className="group-icon-skeleton" key={index} aria-hidden="true" />) : choices.map((icon, index) => {
            const label = language === 'es' ? icon.es[0] ?? icon.name : icon.name.replaceAll('-', ' ');
            return <button className="group-icon-choice" type="button" role="radio" key={icon.name} data-group-icon={icon.name} aria-label={label} title={label} aria-checked={icon.name === group.icon} tabIndex={index === tabbable ? 0 : -1} onClick={() => showIcon(icon, false)} onKeyDown={event => {
              const next = nextRadio(event, first + index, results.length);
              if (next < 0) return;
              setPage(Math.floor(next / PAGE)); showIcon(results[next]!, true);
            }}><span><GroupIcon name={icon.name} /></span></button>;
          })}</div>
          <div className="group-icon-summary"><p className="group-icon-count" role="status" aria-atomic="true">{searcher ? count : t('loading')}<span className="visually-hidden">{results.length > PAGE ? ` ${t('groupIconPage').replace('{start}', String(first + 1)).replace('{end}', String(Math.min(first + PAGE, results.length))).replace('{count}', String(results.length))}` : ''}</span></p>
            {page > 0 && <button type="button" className="group-icon-page" aria-label={t('groupIconsPrevious')} title={t('groupIconsPrevious')} onClick={() => turnPage(page - 1)}><ArrowLeft aria-hidden="true" /></button>}
            {first + PAGE < results.length && <button type="button" className="group-icon-page" aria-label={t('groupIconsNext')} title={t('groupIconsNext')} onClick={() => turnPage(page + 1)}><ArrowRight aria-hidden="true" /></button>}
            {group.icon && <button type="button" className="group-inline-action" onClick={() => { void update({ icon: null }).then(() => searchRef.current?.focus()); }}>{t('groupNoIcon')}</button>}
          </div></>}
    </div>
    <span className="visually-hidden" role="status">{saved ? t('settingsSaved') : ''}</span>
    {pickerOpen && <GroupColorPicker key={group.id} color={pickable} language={language} opener={customRef} editor={ref} pickerRef={pickerRef} onColor={color => { void update({ color }); }} onClose={() => { setPickerOpen(false); customRef.current?.focus(); }} />}
  </div></PopupAnchor>;
}
function GroupSwatch({ color, palette, custom, checked, refObject, label, onChoose, onKeyDown, expanded }: {
  color: string; palette: GroupPalette; custom: boolean; checked: boolean; refObject?: RefObject<HTMLButtonElement | null>; label: string; onChoose: () => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void; expanded?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useGroupPaint(ref, color, palette);
  return <button className={`group-swatch${custom ? ' custom' : ''}`} type="button" role="radio" ref={element => { ref.current = element; if (refObject) refObject.current = element; }} aria-label={label} title={label} aria-checked={checked} tabIndex={checked ? 0 : -1} aria-controls={expanded ? 'group-color-picker' : undefined} onClick={onChoose} onKeyDown={onKeyDown}><span className="swatch-ring"><span>{custom && !checked && <Plus aria-hidden="true" />}</span></span></button>;
}
function GroupColorPicker({ color, language, opener, editor, pickerRef, onColor, onClose }: {
  color: string; language: Language; opener: RefObject<HTMLButtonElement | null>; editor: RefObject<HTMLDivElement | null>; pickerRef: RefObject<HTMLDivElement | null>; onColor: (color: GroupColor) => void; onClose: () => void;
}) {
  const t = (key: CopyKey) => text(key, language);
  const [value, setValue] = useState(() => hexToHSV(color)), [draft, setDraft] = useState(color), [invalid, setInvalid] = useState(false);
  const area = useRef<HTMLDivElement>(null), hexField = useRef<HTMLInputElement>(null), frame = useRef<number | null>(null), latest = useRef(color), colorCallback = useRef(onColor);
  useLayoutEffect(() => { colorCallback.current = onColor; });
  useLayoutEffect(() => {
    const picker = pickerRef.current;
    if (!picker) return;
    picker.style.setProperty('--picker-hue-color', hsvToHex({ h: value.h, s: 100, v: 100 })); picker.style.setProperty('--picker-color', hsvToHex(value));
    picker.style.setProperty('--picker-saturation', `${value.s}%`); picker.style.setProperty('--picker-brightness', `${100 - value.v}%`);
  }, [pickerRef, value]);
  useEffect(() => { area.current?.focus(); return () => { if (frame.current !== null) { cancelAnimationFrame(frame.current); colorCallback.current(latest.current as GroupColor); } }; }, []);
  const change = (next: HSV) => {
    const bounded = { h: Math.max(0, Math.min(360, next.h)), s: Math.max(0, Math.min(100, next.s)), v: Math.max(0, Math.min(100, next.v)) }, picked = hsvToHex(bounded);
    setValue(bounded); setDraft(picked); setInvalid(false); latest.current = picked;
    // Pointer movement sends one command per paint; the last value still goes out when the picker closes.
    frame.current ??= requestAnimationFrame(() => { frame.current = null; colorCallback.current(latest.current as GroupColor); });
  };
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.type === 'pointerdown') { if (event.button !== 0) return; event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); }
    else if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = event.currentTarget.getBoundingClientRect();
    change({ ...value, s: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * 100, v: (1 - Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))) * 100 });
  };
  const apply = (typed: string) => {
    if (!/^#?[a-f\d]{6}$/i.test(typed)) return false;
    change(hexToHSV(typed.startsWith('#') ? typed : `#${typed}`)); return true;
  };
  return <PopupAnchor opener={opener} beside besideAnchor={editor} besideInset={11} gap={8}><div className="group-color-picker" id="group-color-picker" ref={pickerRef} role="dialog" aria-label={t('groupCustomColour')} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    else if (event.key === 'Tab') { const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('[role=slider], input:not(:disabled), button:not(:disabled)')]; if (document.activeElement === (event.shiftKey ? stops[0] : stops.at(-1))) { event.preventDefault(); event.stopPropagation(); onClose(); } }
  }}>
    <div className="group-color-area" ref={area} role="slider" tabIndex={0} aria-label={t('groupSaturationBrightness')} aria-describedby="group-color-area-keys" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value.s)} aria-valuetext={t('groupColourAreaValue').replace('{s}', String(Math.round(value.s))).replace('{v}', String(Math.round(value.v)))} onPointerDown={drag} onPointerMove={drag} onKeyDown={event => {
      const step = event.shiftKey ? 10 : 1, next = { ...value };
      if (event.key === 'ArrowLeft') next.s -= step; else if (event.key === 'ArrowRight') next.s += step; else if (event.key === 'ArrowUp') next.v += step; else if (event.key === 'ArrowDown') next.v -= step; else if (event.key === 'Home') next.s = 0; else if (event.key === 'End') next.s = 100; else return;
      event.preventDefault(); change(next);
    }}><span className="group-color-marker" aria-hidden="true" /></div>
    <span className="visually-hidden" id="group-color-area-keys">{t('groupColourAreaKeys')}</span>
    <input className="group-hue" type="range" min={0} max={360} step={1} value={Math.round(value.h)} aria-label={t('groupHue')} aria-valuetext={t('groupHueValue').replace('{h}', String(Math.round(value.h)))} onChange={event => change({ ...value, h: Number(event.target.value) })} />
    <div className="group-picker-hex"><span className="group-color-preview" aria-hidden="true" /><div className="group-hex-field"><label className="visually-hidden" htmlFor="group-hex">{t('groupHex')}</label><input id="group-hex" className="group-field" ref={hexField} value={draft} maxLength={7} type="text" spellCheck={false} autoComplete="off" aria-invalid={invalid} aria-describedby={invalid ? 'group-hex-error' : undefined} onChange={event => { setDraft(event.target.value); if (apply(event.target.value)) setInvalid(false); }} onBlur={() => { if (!/^#?[a-f\d]{6}$/i.test(draft)) setInvalid(true); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (apply(draft)) onClose(); else setInvalid(true); } }} /></div><button className="profile-action primary" type="button" onClick={() => { if (apply(draft)) onClose(); else { setInvalid(true); hexField.current?.focus(); } }}>{t('useGroupColour')}</button></div>
    {invalid && <p className="group-field-error" id="group-hex-error" role="alert">{t('groupHexInvalid')}</p>}
  </div></PopupAnchor>;
}
