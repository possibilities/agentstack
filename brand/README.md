# ArtHack — icon kit

Made with ArtHack Icon Factory.

Each light-mode/ and dark-mode/ folder is a complete alternative set. Light mode uses #000000; dark mode uses #ffffff. Mobile launcher and PWA assets have opaque paper backgrounds. Desktop, general PNG, and vector masters preserve transparency.

## Browser
Copy web/, light-mode/, and dark-mode/ to /brand/ in your app's public directory and use browser-head.html. /brand/web/favicon.svg uses an internal prefers-color-scheme rule to show light-mode ink in light appearance and dark-mode ink in dark appearance; copy light-mode/web/favicon.ico to your site root as /favicon.ico for legacy fallback, but do not advertise it as a second icon link: Chrome can select the black ICO over the SVG even when the ICO has explicit sizes. The separate mode-specific favicons remain available if your app sets its own theme: match your app theme by setting the favicon link href directly, because prefers-color-scheme follows the browser/OS and not your app's theme toggle. After replacing favicon files, change the URL or version it if a browser shows a cached tab icon. browser-head.html selects the light-mode web/site.webmanifest; installed PWA icons and backgrounds use that one chosen variant and do not automatically switch with browser appearance. Choose the dark-mode manifest instead if desired, and adjust its start_url, names, and paths for the host app.

## iOS / iPadOS
Choose a mode and import mobile/ios/AppIcon.appiconset into Assets.xcassets. It includes iPhone, iPad, and the opaque 1024px App Store icon. Both mode folders are alternatives, not automatically configured iOS appearance slots. No rounded corners are baked in. These flattened assets do not include layered Icon Composer artwork.

## Android
Choose a mode and merge mobile/android/res into the app resources. Set android:icon="@mipmap/ic_launcher" and android:roundIcon="@mipmap/ic_launcher_round" on the application. Includes five legacy density sets, adaptive foreground/background layers for API 26+, and monochrome resources for themed icons on API 33+. Android applies its own mask. The foreground stays inside a centered 60%-diameter safe circle on the 108dp canvas. play-store-512.png is the opaque store icon.

## Desktop
Windows: use desktop/windows/arthack.ico (16, 24, 32, 48, 64, 128, 256px PNG entries). macOS: use desktop/macos/arthack.icns or the included Xcode appiconset. Linux: merge desktop/linux/hicolor into the package's icon theme directory and use Icon=arthack in its .desktop entry. Electron/Tauri can use the appropriate platform file; application signing and packaging remain the host project's responsibility.

## Framing and files
SVG masters and scalable favicons crop to the visible faces with no inherited artboard margins. Their intrinsic dimensions preserve the artwork aspect ratio; size is the longest edge. Add visual padding in the host app. Square platform PNGs center the visible artwork and fill its longest edge without presentation padding. Maskable PWA and adaptive Android assets retain their required safe areas. Icons are not screenshots and include no purchased reference overlay or private purchase evidence. studio-recipe.json records the design settings.

Geometry: tesseralis/polyhedra-viewer, MIT, copyright 2018 Nat Alison; geometric data credited by upstream to George W. Hart. License included in this ZIP.
