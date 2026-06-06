module.exports = {
  apps: [
    {
      name:          'restaurant-crm',
      script:        'server.js',
      watch:         false,
      restart_delay: 3000,
      max_restarts:  20,
      node_args:     '--max-old-space-size=512',
      env: { NODE_ENV: 'production' },
    },
    {
      name:          'restaurant-public',
      script:        'public-server.js',
      watch:         false,
      restart_delay: 3000,
      max_restarts:  20,
      node_args:     '--max-old-space-size=128',
      env: { NODE_ENV: 'production' },
    },
  ],
};
