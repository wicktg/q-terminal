import type { MetadataRoute } from "next";

// Lets phones install the terminal to the home screen and open it full screen, like an app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Q Terminal",
    short_name: "Q",
    description: "Crypto market terminal",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
