import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.edsonmatematico.benehimedraw',
  appName: 'BenehimeDraw',
  webDir: 'excalidraw-app/build',
  server: {
    hostname: 'excalidraw.com',
  },
};

export default config;
