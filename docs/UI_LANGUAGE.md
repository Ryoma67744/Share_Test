# Application language

The application shares one `ja` / `en` preference across Projects, Viewer, MRM
and Help. The preference is stored in `desi:ui:lang` in the current browser
origin; the old Help preferences are migrated and kept in sync. Online and
offline origins have independent preferences. Language changes do not reload
the page or update project data.

Load `app-i18n.js`, `app-i18n-common.js` and the page catalogs before application
code. Catalog filenames use `app-i18n-*.js` and are bundled for both distributions.
The offline server explicitly permits these assets; no translation service is
called.

For later releases that change an already published language module or catalog,
update its script URL revision consistently in all importing pages. Help and PPT
assets already use versioned URLs; bump those revisions together with their
content. The offline server sends `Cache-Control: no-store`.

## Translate explicit UI sources

```js
AppI18n.register('example', {'{name} を開く': 'Open {name}'});
AppI18n.t('{name} を開く', {name: project.name}); // current-language string
AppI18n.tFor('en', '{name} を開く', {name: project.name}); // fixed-language export
AppI18n.setText(label, '{name} を開く', {name: project.name}); // live binding
AppI18n.setAttribute(input, 'placeholder', '検索');
```

`setText` updates text content, so use a dedicated span inside controls that also
contain an icon or input. An imperative binding releases ownership if unrelated
code replaces its text or attribute. `clearBinding(node[, attribute])` releases
it explicitly. A parameter function is reevaluated on each language change;
use it for nested UI labels, not a cached translated string.

```html
<label><input type="checkbox"><span data-i18n="保存">保存</span></label>
<input data-i18n-placeholder="検索" placeholder="検索">
```

Supported translated attributes are `title`, `placeholder`, `aria-label` and
`alt`. `data-i18n-params` supplies JSON parameters. `AppI18n.html(source, params)`
(also named `span`) returns a bound span with escaped text and parameters.
`AppI18n.attr(name, source, params)` returns an escaped translated attribute and
its binding metadata. These helpers accept UI text, not arbitrary HTML.

Unmarked DOM, input values, identifiers, data fields and user names are never
scanned for translation. Parameters are inserted as values, not translation
keys. Preserve option values and data formats when changing their labels.

## Context and language changes

The scoped `mrm-role` catalog distinguishes the MRM role `確認` (Qualifier) from
the generic confirmation action (Confirm). Scoped catalogs do not change global
wording. Register with `{scoped: true}`; pass the namespace after parameters to
`t`, `html`, `setText`, `attr` and `setAttribute`, or add
`data-i18n-namespace="mrm-role"` to the marked element or an ancestor.

`getLocale`, `setLocale` and `onChange` manage the preference. `onChange` returns
an unsubscribe function. Use `createSwitcher(container)` or add
`data-i18n-switch` to a language select or toggle button. Redraw language-sensitive
canvas captions on change without rebuilding forms or changing scientific data.
For long-running exports, capture the selected locale and call `tFor` throughout
the export.

## Verification

`getMissingKeys` records untranslated Japanese UI sources requested in English;
`getConflicts` reports inconsistent global wording. The language regressions
cover storage, safe interpolation, scoped terms, live state preservation and Help.
`tools/help-capture.cjs` captures the synthetic workflows in both languages and
checks editing-state preservation and visible untranslated UI. Measured brain
figures retain their original images and provenance.
