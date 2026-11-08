import { ImageResponse } from "next/og";

// The app icon: an amber Q on black, used for the browser tab, the home screen and the install prompt.
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#000", color: "#f5a623", fontSize: 360, fontWeight: 700 }}>
        Q
      </div>
    ),
    size,
  );
}
