# Agent Guidelines

You are an expert in TypeScript, Angular, NgRx, PrimeNG, and scalable web applications. Write functional, maintainable, performant, accessible code that follows the existing project patterns first.

## Working Principles

- Keep changes scoped to the requested behavior.
- Prefer the simplest direct implementation that fits the current codebase.
- Do not introduce abstractions, generic helpers, or new patterns unless they remove real duplication or match an existing local pattern.
- Preserve user changes. Never revert unrelated work.
- Before editing, inspect nearby files and reuse the same naming, folder structure, state flow, styles, and component patterns.
- After editing, run focused checks first, then broader checks when the change touches shared behavior.

## TypeScript

- Use strict typing and avoid `any`. Use `unknown` when the type is truly uncertain.
- Prefer type inference when the type is obvious from the initializer.
- Use small domain types with clear names instead of loosely shaped objects.
- Keep transformations pure and predictable.
- Do not silence type errors with casts unless the boundary is genuinely untyped and the cast is contained.
- Prefer `readonly` for injected dependencies, constants, signal inputs/outputs, and values that should not be reassigned.

## Angular

- Use standalone components. Do not set `standalone: true` in decorators; it is the default in modern Angular.
- Set `changeDetection: ChangeDetectionStrategy.OnPush` for components.
- Use `inject()` instead of constructor injection.
- Use `input()` and `output()` instead of `@Input()` and `@Output()` for new or refactored components.
- Use the `host` object in the component/directive decorator instead of `@HostBinding` and `@HostListener`.
- Keep lifecycle hooks short. Move real work into clearly named methods.
- Keep components focused on UI orchestration. Move reusable validation, mapping, or formatting logic into small functions/services only when it is reused or materially clarifies the component.
- Use `NgOptimizedImage` for static images. Do not use it for dynamic blob/base64 previews.

## Project Structure

- Organize by feature area and follow the existing folder layout.
- For pages and feature components, keep TypeScript, template, and styles in separate files: `*.component.ts`, `*.component.html`, `*.component.scss`.
- Do not put substantial templates inline in component TypeScript files.
- Keep file names aligned with the main exported class or component.
- Avoid generic buckets like `helpers.ts`, `utils.ts`, or `common.ts` unless the surrounding feature already uses them and the content is genuinely shared.

## Templates

- Use native Angular control flow: `@if`, `@for`, and `@switch`.
- Always provide a stable `track` expression for `@for`.
- Keep templates readable. Move complex conditions and derivations to `computed()` or named methods.
- Do not use `ngClass`; use `[class.foo]` or `[class]`.
- Do not use `ngStyle`; use `[style.foo]` or `[style]`.
- Name event handlers for what they do, not for the DOM event. Prefer `saveCarrier()` over `handleClick()`.
- Do not call expensive functions from templates. Use signals, selectors, `computed()`, or precomputed view models.

## Forms And PrimeNG

- Prefer Reactive Forms over template-driven forms.
- Do not mix `ngModel` with reactive forms in feature forms.
- All user-facing inputs, selects, date pickers, checkboxes, radios, textareas, buttons, and tables should use PrimeNG components or existing project wrappers unless the feature already has a different established pattern.
- Use the project’s existing form classes and validation display patterns.
- Show validation after save attempts and when controls are touched/dirty, following nearby forms.
- Keep validation close to the form when it is feature-specific. Extract validators only when reused or non-trivial.
- Use PrimeNG public APIs such as `styleClass`, `class`, documented inputs, templates, CSS variables, and design tokens instead of styling private DOM internals.

## State Management

- Use signals for local component state.
- Use `computed()` for derived local state.
- Do not mutate signal values in place. Use `set()` or `update()`.
- Existing feature/server state belongs in NgRx. Components should dispatch through the feature store/facade service and read selectors/observable streams from it.
- API calls should live in services/effects, not directly in page components.
- Reducers must be pure and typed. Do not use `ActionType<any>` or untyped payload access.
- Effects should stay readable: one responsibility per effect, explicit success/failure actions, and contained error handling.

## Styling

- Do not use `:host ::ng-deep`, `::ng-deep`, `/deep/`, or `>>>`.
- Do not add `ViewEncapsulation.None` to bypass style scoping.
- Use `:host` only for host-level layout/state styling that belongs to the component itself.
- Prefer component-owned classes with clear names over targeting library internals.
- For PrimeNG customization, use documented component inputs/templates, `styleClass`, CSS variables/design tokens, or a scoped project class in a shared stylesheet.
- If a global override is unavoidable, put it in the relevant shared/global stylesheet, scope it with a project-specific parent class, and add a short comment explaining why.
- Avoid `!important`. Use it only as a last resort for third-party overrides, scoped narrowly.
- Keep styles responsive and predictable. Use `min-width: 0`, explicit grid/flex constraints, and stable dimensions where content can otherwise overflow.
- Do not create visual regressions by changing global styles for one local issue.

## Accessibility

- Prefer native interactive elements (`button`, `a`, `input`, `select`) or accessible PrimeNG components over custom clickable `div`s.
- Every icon-only button must have an accessible name via `aria-label`, visible text, or equivalent PrimeNG support.
- Preserve keyboard access, focus states, focus order, and visible focus indication.
- Use ARIA attributes only to add missing semantics; do not use ARIA to replace correct HTML.
- Dialogs, overlays, menus, and destructive actions must have clear focus behavior and accessible labels.
- Do not rely on color alone to communicate state.
- Maintain WCAG AA contrast.

## Performance

- Keep change detection friendly: use OnPush, signals, selectors, and stable references.
- Avoid repeated expensive filtering/sorting/mapping from templates.
- Use lazy-loaded feature routes.
- Avoid unnecessary subscriptions. Prefer `async` pipe, signals via `toSignal`, or existing store patterns.
- Clean up manual subscriptions with `takeUntilDestroyed()` or an equivalent existing project pattern.

## Testing And Verification

- Run `git diff --check` after edits.
- Run focused tests for the changed feature when available.
- Run `ng build` for Angular/template/type-safety validation when the change touches components, templates, routing, forms, or shared types.
- For UI changes, verify common responsive widths and ensure text does not overflow or overlap.
- Before finishing, search for banned patterns introduced by the change, especially `::ng-deep`, `ngModel` in reactive forms, `any`, `ngClass`, `ngStyle`, `standalone: true`, `@HostBinding`, and `@HostListener`.

## Communication

- Explain what changed and what was verified.
- Mention any checks that could not be run.
- Keep summaries concise and focused on behavior, risk, and verification.
