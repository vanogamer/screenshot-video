module.exports = {
  apps: [
    {
      name: 'video-screenshot-site',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: '3004',
        HOST: '0.0.0.0',
        MAX_UPLOAD_SIZE_BYTES: String(50 * 1024 * 1024 * 1024),
        FFPROBE_TIMEOUT_MS: '120000',
        MIN_FREE_RAM_BEFORE_JOB_BYTES: String(1024 * 1024 * 1024),
        MIN_DYNAMIC_RAM_FOR_4K_BYTES: String(1536 * 1024 * 1024),
        PNG_COMPRESSION_LEVEL: '0',
        PNG_PIXEL_FORMAT: 'rgb24',
        ALLOW_OUTPUT_RESIZE: 'false'
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1500,
      time: true
    }
  ]
};