---
name: PromptPal
description: A restrained warm-paper product UI with graphite actions and colourful data accents.
colors:
  canvas: "#f9f8f6"
  paper: "#fdfdfc"
  ink: "#2c2621"
  muted-ink: "#6b6257"
  border: "#e7e2da"
  primary: "#2c2926"
  primary-foreground: "#fdfdfc"
  warning: "#8a550f"
  destructive: "#dc2828"
  chart-persimmon: "#c35a1d"
  chart-azure: "#1f73e0"
  chart-amber: "#f3b816"
  chart-teal: "#1da58a"
  chart-plum: "#9b51b8"
typography:
  display:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "normal"
  headline:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "normal"
  title:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "normal"
  numeric:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  "2xl": "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "8px 16px"
    typography: "{typography.label}"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "8px 16px"
    typography: "{typography.label}"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "24px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "8px 12px"
    typography: "{typography.body}"
  tabs-list:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted-ink}"
    rounded: "{rounded.md}"
    padding: "4px"
---

# Design System: PromptPal

## 1. Overview

**Creative North Star: "The Warm Workbench"**

PromptPal should feel like a calm work surface for repeated AI tasks: warm, legible, compact, and trustworthy. The interface is not a marketing object. It is a product surface that should disappear into file upload, model choice, prompting, chat review, transcription, and usage analysis.

The design is restrained by default. Warm neutral canvas creates the room, paper surfaces hold the work, graphite marks primary actions, and colourful chart hues are reserved for data. White-looking paper is intentional, but it is never the whole world. Figure and ground come from the canvas/paper relationship, borders, and small shadows.

This system rejects generic AI-wrapper styling: dark blue dashboards, purple gradients, glass panels, decorative glow, and over-carded layouts. It should feel familiar to people who trust Linear, Notion, Raycast, Stripe, and Claude-style product surfaces.

**Key Characteristics:**

- Warm neutral canvas with paper-like elevated surfaces.
- Graphite primary actions instead of saturated brand colour everywhere.
- Colourful data visualization, kept separate from UI action colour.
- Compact product typography with Hanken Grotesk and numeric JetBrains Mono.
- Borders and restrained shadows for structure, not decoration.

## 2. Colors

The palette is warm-neutral first, graphite for action, and colourful only where data needs categorical distinction.

### Primary

- **Graphite Ink** (`primary`): The default primary action, focus ring, selected emphasis, and active control colour. It is near-black with a warm tint so it sits naturally on the paper palette.
- **Paper White** (`primary-foreground`): Text and icons on graphite primary actions.

### Secondary

- **Persimmon Data** (`chart-persimmon`): The lead chart colour and cost-tooltip prompt colour. It is not the primary UI action colour.
- **Azure Data** (`chart-azure`), **Amber Data** (`chart-amber`), **Teal Data** (`chart-teal`), **Plum Data** (`chart-plum`): Supporting categorical chart colours. They should appear in charts, legends, and data breakdowns, not as routine button decoration.

### Neutral

- **Warm Canvas** (`canvas`): The app page field. Route shells and large work areas should usually use this colour.
- **Paper Surface** (`paper`): Cards, panels, composer boxes, dialogs, headers, footers, and input fills. `bg-card`, `bg-background`, and `bg-popover` intentionally share this paper tone.
- **Warm Ink** (`ink`): Primary text.
- **Soft Ink** (`muted-ink`): Secondary text, helper copy, inactive controls, legends, and quiet metadata.
- **Warm Border** (`border`): Dividers, control outlines, panel edges, and the primary figure/ground separator.
- **Readable Amber** (`warning`): Warning text and subtle warning borders/fills. Use pale amber fills via opacity, not bright amber text on bright amber backgrounds.
- **Destructive Red** (`destructive`): Destructive actions and error states only.

### Named Rules

**The Canvas/Paper Rule.** `bg-muted` is the app canvas. `bg-card` is elevated paper. `bg-background` is paper/control fill, not the page background.

**The Graphite Action Rule.** Primary UI actions use graphite. Do not turn charts, empty states, or inactive controls into graphite blocks just to add weight.

**The Data Colour Rule.** Persimmon and the chart palette belong to data visualization and cost breakdowns. They are allowed to be colourful because they explain information.

## 3. Typography

**Display Font:** Hanken Grotesk with system sans fallback

**Body Font:** Hanken Grotesk with system sans fallback

**Label/Mono Font:** JetBrains Mono for selected numeric and code-like readings

**Character:** Hanken Grotesk gives the app a warmer product voice than default system UI without becoming decorative. JetBrains Mono is an instrument face, used where aligned digits or technical text genuinely help.

### Hierarchy

- **Display** (600, 3rem, 1 line-height): Large page-level metrics and rare hero-scale statements such as the lead statistic.
- **Headline** (600, 2rem, 1.2 line-height): Page titles and major view headings.
- **Title** (600, 1.25rem, 1.3 line-height): Card titles, panel headings, and major component titles.
- **Body** (400, 1rem, 1.5 line-height): General copy, messages, descriptions, and settings text. Long prose should stay around 65-75ch.
- **Label** (500, 0.875rem, 1.25 line-height): Buttons, tabs, controls, field labels, and compact metadata.
- **Numeric** (500, 0.875rem, 1.25 line-height): Version labels, large dashboard numbers, timestamps, code, and values where tabular alignment matters.

### Named Rules

**The Instrument Rule.** Use JetBrains Mono for data and code-like values, not for every chip that happens to contain a number.

**The Product Scale Rule.** Keep type sizes fixed and calm. Do not use viewport-scaled headings inside dashboards, sidebars, composer controls, or panels.

## 4. Elevation

PromptPal uses a hybrid of tonal layering and restrained shadows. Most depth comes from `canvas` behind `paper`, plus `border`. Shadows are small and structural: enough to show that a composer, card, or floating control is interactable, never enough to become visual style on their own.

### Shadow Vocabulary

- **Card Lift** (`shadow-sm`): Default elevation for cards and paper panels. Use with `border` and `paper`.
- **Floating Control** (`shadow-lg`): Collapsed side-panel buttons, floating action clusters, and overlay controls.
- **Composer Lift** (`0 4px 14px rgba(15,23,42,0.05)`): Chat composer and other high-attention input surfaces.
- **Bottom Bar Lift** (`0 -8px 24px rgba(15,23,42,0.05)`): Sticky audio and transcription control bars.

### Named Rules

**The Border-First Rule.** A surface should read through canvas, paper, and border before it needs a shadow.

**The No Floating Sections Rule.** Page sections are not generic floating cards. Use cards for actual repeated items, framed tools, dialogs, and elevated controls.

## 5. Components

### Buttons

- **Shape:** Gently rounded rectangles (8px default, 6px extra-small).
- **Primary:** Graphite fill with paper text. Use for real commands: Generate, Send, Stop Recording, Reprocess, confirm actions.
- **Hover / Focus:** Hover darkens or softens via opacity. Focus uses a 2px graphite ring with a paper offset.
- **Secondary / Ghost / Outline:** Secondary controls sit on paper or transparent backgrounds with muted hover fills. Ghost buttons should stay visually quiet until hovered.
- **Disabled:** Disabled controls use opacity and should not look like active brand accents.

### Chips

- **Style:** Rounded pills with small text, restrained borders, and either paper or subtle neutral fills.
- **State:** Selected or active chips may use muted fills or ink-wash overlays. Avoid saturated inactive chips.

### Cards / Containers

- **Corner Style:** Rounded paper containers (10px to 14px depending on scale).
- **Background:** Paper surface on warm canvas.
- **Shadow Strategy:** `shadow-sm` at rest. Use stronger shadow only for floating controls or overlays.
- **Border:** Warm border is expected and should usually remain visible.
- **Internal Padding:** 16px for compact panels, 24px for main cards.

### Inputs / Fields

- **Style:** Paper/control fill with warm border, 8px radius, compact 40px height.
- **Focus:** Graphite focus ring with paper offset. Prefer focus rings over changing the whole fill.
- **Error / Disabled:** Error states use destructive red text/border. Disabled states reduce opacity and keep layout stable.

### Navigation

- **Style:** The overlay header is compact and product-like. Mobile uses a solid paper bar with a divider. Desktop routes can choose floating or divided header behaviour.
- **Mode Switchers:** Use a muted track with paper active pills. Active state is visible through fill, border, and shadow, not saturated colour.
- **Footer:** Fixed paper footer with a top border. It is utility chrome, not a brand strip.

### Composer And Work Surfaces

- **Composer:** Paper surface, rounded-xl, border, restrained shadow, and a graphite send action. Reserve paper/white for the actual input and attached notices.
- **Chat Canvas:** Conversation flow sits on canvas. Assistant responses can be transparent; user prompts use subtle ink-wash bubbles.
- **Transcription:** Idle/drop and processing controls use paper surfaces on canvas. Transcript reading can sit calmer, with active rows and playback states using graphite.

## 6. Do's and Don'ts

### Do:

- **Do** use `bg-muted` for route/page canvas and `bg-card` for elevated paper.
- **Do** keep `bg-background` for inputs, dialogs, active pills, and small controls.
- **Do** use `bg-foreground/[0.02-0.07]` for subtle recessed rows or hover states that must work on both canvas and paper.
- **Do** keep primary actions graphite and scarce.
- **Do** use the chart palette for data visualization, legends, and cost breakdowns.
- **Do** maintain visible warm borders when paper sits on paper-like surroundings.
- **Do** test contrast whenever token lightness changes.

### Don't:

- **Don't** use `bg-background` as a synonym for page background unless the whole page is intentionally paper.
- **Don't** flatten the app by putting `bg-card` on every large route shell.
- **Don't** use faint `bg-muted/20` layers on top of `bg-muted`; they disappear. Use ink-wash overlays or paper.
- **Don't** use bright amber backgrounds with amber text for warnings.
- **Don't** make inactive controls saturated, glossy, or brand-coloured.
- **Don't** use purple gradients, glassmorphism, decorative glow, or generic AI-wrapper styling.
- **Don't** add nested cards or card grids just to create hierarchy. Use layout, border, typography, and canvas/paper separation first.
