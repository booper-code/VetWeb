import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the development indicator away from the sidebar footer.
  devIndicators: {
    position: 'bottom-right',
  },
  // Staging is static hosting only; ordinary builds retain Next's default output.
  ...(process.env.VETCLOUD_STATIC_EXPORT === '1' ? { output: 'export' as const } : {}),
};

export default nextConfig;
