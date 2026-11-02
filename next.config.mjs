import { networkInterfaces } from "node:os";

// This machine's current LAN addresses, so phones keep working when the network changes.
const lan = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === "IPv4" && !n.internal)
  .map((n) => n.address);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Lets phones and other devices on the home network use the dev server.
  allowedDevOrigins: lan,
  // The dev badge sits on top of the mobile tab bar.
  devIndicators: false,
};
export default nextConfig;
