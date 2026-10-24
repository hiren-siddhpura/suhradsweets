# Suhrad Sweets OMS UI/UX Guidelines

## UI audit, October 2026

The application already had a shared HTML shell and a warm visual direction, but the audit found several usability issues:

- Mobile users had to open an off-canvas menu for every page and could not quickly return to common workflows.
- Filters, form fields, dialogs, table actions, and status text used slightly different spacing and control sizes.
- Long tables were hard to use on phones without a clear indication that they could scroll.
- Dialogs could feel cramped on smaller screens, and their primary actions were not kept within reach.
- Order and invoice status was shown as plain text in places where a clear visual label is easier to scan.

## Design tokens

The shared stylesheet defines the warm neutral surface, saffron primary action color, readable text colors, semantic success/warning/danger colors, three radii, shared spacing values, a 42 px control height, and a 44 px minimum touch target. Use these variables before adding one-off colors or dimensions.

## Components

- Use `.button-primary` for one primary action in a section or dialog and `.button-outline` for supporting actions.
- Use `.ops-field` and `.master-field` for labelled form controls. Required fields must retain a visible `*` in their label.
- Use `.status-badge` or `.order-status-badge` for a status that needs to be scanned. Include text; color must not carry the meaning alone.
- Use `.ops-toolbar` for search, filters, and export controls. Search takes its own row on small screens.
- Use `.card` for a related group of information, with existing table and summary patterns inside it.
- Use `showToast` only for short confirmation feedback. Form errors remain next to the form and use understandable text.

## Responsive rules

- Desktop retains the sidebar and uses the full table layout.
- At 760 px and below, the app supplies a bottom bar for Home, Orders, Customers, Invoices, and More. More opens the existing permission-aware navigation, so no authorized destinations are hidden.
- Dialogs become full-screen at the mobile breakpoint, with the header and actions kept visible while a long form scrolls.
- Filters wrap, touch targets remain at least 44 px, and content keeps clearance for the bottom navigation and safe-area inset.
- Tables remain scrollable when data cannot be represented safely as cards; the UI announces this with a small scroll hint.

## Accessibility and QA checklist

- Confirm a visible keyboard focus ring on every input, select, and action.
- Confirm labels and button text describe the action without relying on an icon.
- Check an empty, loading, success, and error state for each changed page.
- Check the app at 320, 360, 390, 430, 768, 1024, and 1366 px widths.
- Check each role sees only its authorized navigation and actions.
- Confirm UI changes do not create Firestore writes or change Cloud Function authorization.
- Run `npm run test:unit`; run Emulator Suite tests for any workflow or backend changes.
