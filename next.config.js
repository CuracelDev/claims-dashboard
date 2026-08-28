/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '200mb',
    },
  },
  outputFileTracingExcludes: {
    '/api/tools/piles-auto-assignment/run': [
      './app/**/*',
      './lib/**/*',
      './public/**/*',
      './scratch/**/*',
      './tmp/**/*',
      './scripts/**/*',
      './*.{js,json,md}',
      './Dockerfile*',
    ],
  },
  outputFileTracingIncludes: {
    '/api/tools/piles-auto-assignment/run': ['./scripts/piles_auto_assignment_runner.py'],
  },
};
module.exports = nextConfig;
