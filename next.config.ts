import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // الخادم يعمل على Node runtime فقط (SDK و libsql يتطلبان Node)
  poweredByHeader: false,
};

export default nextConfig;
