import auth from './auth.js';
import content from './content.js';
import collab from './collab.js';
import knowledge from './knowledge.js';
import admin from './admin.js';
import integrations from './integrations.js';

export default function registerRoutes(router, app) {
  for (const mod of [auth, content, collab, knowledge, admin, integrations]) mod(router, app);
}
