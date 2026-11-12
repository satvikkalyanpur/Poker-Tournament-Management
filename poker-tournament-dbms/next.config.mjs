/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Keep the PostgreSQL driver on the server; it must never be bundled
    // into a client component. (Next 15 renames this to serverExternalPackages.)
    serverComponentsExternalPackages: ['pg', 'bcryptjs'],
  },
};

export default nextConfig;
