/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle (.next/standalone) so the production image ships only the
  // traced runtime deps — a small, reproducible container instead of the whole node_modules tree.
  output: 'standalone',
};

export default nextConfig;
