# LoginScreen

Sign-in as a split screen: the brand panel on `chrome`, the form on `canvas`.

Brand panel: the white logo (40px), the `display-xl` headline `Операционный контроль бизнес-авиации` with one sentence in `on-chrome-muted`, three thin trajectory arcs in `chrome-line` and one dashed arc with end points in `chrome-accent`, and a live METAR line plus the Zulu time at the bottom in `code`. Form: DEMO badge when applicable, `Вход в SOC` in `page-title`, 40px inputs, remember-device checkbox, primary `Войти` full width, the directory sign-in as secondary, and the registration link.

Keep the existing auth flow, 2FA and registration modal; this card only restyles them. Below 900px the panel becomes a 160px band with only the logo.
