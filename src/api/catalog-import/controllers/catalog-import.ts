/**
 * Custom catalog-import controller.
 *
 * Accepts a validated/normalized product group from the Nuxt BFF and orchestrates
 * creation of a cabinet type, its variants + prices, depth option links, and
 * surcharge links + prices inside a single database transaction so any failure
 * rolls back the entire import.
 */

import type { Core } from '@strapi/strapi';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async product(ctx: any) {
    const body = ctx.request.body ?? {};
    if (!body || typeof body !== 'object') {
      return ctx.badRequest('Invalid body');
    }

    try {
      const result = await strapi
        .service('api::catalog-import.catalog-import')
        .importProduct(body);
      return result;
    } catch (err: any) {
      if (err && err.status && err.name) throw err;
      const message =
        (err && typeof err.message === 'string' && err.message) || 'Catalog import failed';
      ctx.throw(502, message);
    }
  },
});
