import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@cocally/shared'],
  // Self-contained server bundle for the Docker image (apps/web/Dockerfile).
  output: 'standalone',
  // Monorepo root, so the standalone bundle traces workspace dependencies.
  outputFileTracingRoot: path.join(__dirname, '../../'),
};

export default nextConfig;
