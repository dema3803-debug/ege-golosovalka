// Манифест приложения с личной ссылкой: иконка на телефоне сразу открывает свой план.
export default function handler(req, res) {
  const u = /^[a-z0-9]{16,40}$/.test(req.query.u || "") ? req.query.u : null;
  res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(JSON.stringify({
    name: "Козя — план подготовки к ЕГЭ",
    short_name: "Козя",
    description: "Личный план подготовки к ЕГЭ с помощницей Козей",
    lang: "ru",
    id: "/app",
    start_url: u ? `/app?u=${u}` : "/app",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#FBEFF3",
    theme_color: "#FBEFF3",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }));
}
