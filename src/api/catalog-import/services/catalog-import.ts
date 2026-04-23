/**
 * Transactional catalog-import service.
 *
 * Everything inside `strapi.db.transaction(...)` automatically participates in
 * the transaction when using `strapi.documents(...)`/`strapi.entityService`/
 * `strapi.db.query`, so any thrown error rolls back the full import.
 */

import type { Core, UID } from '@strapi/strapi';
import { errors } from '@strapi/utils';

const { ApplicationError } = errors;

const CT_CABINET_TYPE: UID.ContentType = 'api::cabinet-type.cabinet-type';
const CT_CABINET_VARIANT: UID.ContentType = 'api::cabinet-variant.cabinet-variant';
const CT_CABINET_PRICE: UID.ContentType = 'api::cabinet-price.cabinet-price';
const CT_CABINET_SERIES: UID.ContentType = 'api::cabinet-serie.cabinet-serie';
const CT_DEPTH_OPTION: UID.ContentType = 'api::depth-option.depth-option';
const CT_SURCHARGE: UID.ContentType = 'api::cabinet-type-surcharge.cabinet-type-surcharge';
const CT_SURCHARGE_LINK: UID.ContentType =
  'api::cabinet-type-surcharge-link.cabinet-type-surcharge-link';
const CT_SURCHARGE_PRICE: UID.ContentType =
  'api::cabinet-type-surcharge-price.cabinet-type-surcharge-price';
const CT_PRICE_CLASS: UID.ContentType = 'api::price-class.price-class';

interface CatalogPriceGroup {
  class: number;
  price: number;
}

interface CatalogWidthEntry {
  value: number | null;
  code: string;
  min: number | null;
  max: number | null;
  LR: boolean;
  priceGroups: CatalogPriceGroup[];
}

interface CatalogDepthOption {
  name: string;
  value: number;
}

interface CatalogSurcharge {
  name: string;
  code: string;
  priceGroups: CatalogPriceGroup[];
}

interface CatalogProductGroup {
  name?: string;
  description?: string;
  width: CatalogWidthEntry[];
  depthOptions: CatalogDepthOption[];
  surcharges: CatalogSurcharge[];
}

interface ImportBody {
  cabinetSeriesDocumentId: string;
  product: CatalogProductGroup;
  imageId?: number | null;
}

type DocId = number | string;

interface ImportResult {
  cabinetType: { id: DocId; documentId: string };
  variants: { orderNumber: string; documentId: string }[];
  variantCount: number;
  cabinetPricesCreated: number;
  skippedPricesMissingPriceClass: number;
  depthOptions: { name: string; action: 'linked' | 'created'; documentId: string }[];
  surcharges: { name: string; action: 'linked' | 'created'; surchargeId: DocId }[];
}

type PriceClassRow = { id: DocId; documentId: string; level: number; priceIndex: number | null };

type PriceClassMaps = {
  byLevel: Map<number, PriceClassRow>;
  byPriceIndex: Map<number, PriceClassRow>;
  ordered: PriceClassRow[];
};

function badRequest(message: string): never {
  throw new ApplicationError(message);
}

function cabinetTypeNameFromProduct(p: CatalogProductGroup): string {
  const n = typeof p.name === 'string' ? p.name.trim() : '';
  if (n) return n.slice(0, 255);
  const d = typeof p.description === 'string' ? p.description.trim() : '';
  if (d) return d.slice(0, 255);
  return 'Imported cabinet type';
}

function resolvePriceClass(catalogClass: number, maps: PriceClassMaps): PriceClassRow | null {
  if (!Number.isInteger(catalogClass)) return null;
  const byPi = maps.byPriceIndex.get(catalogClass);
  if (byPi) return byPi;
  const byLv = maps.byLevel.get(catalogClass);
  if (byLv) return byLv;
  if (catalogClass >= 0 && catalogClass < maps.ordered.length) {
    return maps.ordered[catalogClass];
  }
  return null;
}

function normalizeBody(raw: unknown): ImportBody {
  if (!raw || typeof raw !== 'object') badRequest('Invalid body');
  const b = raw as Record<string, unknown>;

  const cabinetSeriesDocumentId =
    typeof b.cabinetSeriesDocumentId === 'string' ? b.cabinetSeriesDocumentId.trim() : '';
  if (!cabinetSeriesDocumentId) badRequest('cabinetSeriesDocumentId is required');

  const product = b.product;
  if (!product || typeof product !== 'object') badRequest('product is required');

  const p = product as Record<string, unknown>;
  if (!Array.isArray(p.width)) badRequest('product.width must be an array');
  if (!Array.isArray(p.depthOptions)) badRequest('product.depthOptions must be an array');
  if (!Array.isArray(p.surcharges)) badRequest('product.surcharges must be an array');

  let imageId: number | null | undefined;
  if ('imageId' in b) {
    const img = b.imageId;
    if (img === null || img === undefined) imageId = null;
    else if (typeof img === 'number' && Number.isFinite(img)) imageId = img;
    else if (typeof img === 'string' && img.trim() !== '') {
      const n = Number(img.trim());
      imageId = Number.isFinite(n) ? n : undefined;
    }
  }

  return {
    cabinetSeriesDocumentId,
    product: product as CatalogProductGroup,
    imageId,
  };
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async importProduct(raw: unknown): Promise<ImportResult> {
    const { cabinetSeriesDocumentId, product, imageId } = normalizeBody(raw);

    return strapi.db.transaction(async () => {
      const series = await strapi.documents(CT_CABINET_SERIES).findOne({
        documentId: cabinetSeriesDocumentId,
        fields: ['id', 'documentId', 'carcaseHeight'],
      });
      if (!series) badRequest('Cabinet series not found');
      const lockVariantHeight = series.carcaseHeight != null;

      const priceClassRows = (await strapi.documents(CT_PRICE_CLASS).findMany({
        fields: ['id', 'documentId', 'level', 'priceIndex'],
        pagination: { limit: -1 },
      })) as unknown as PriceClassRow[];
      if (priceClassRows.length === 0) {
        badRequest('No price classes found. Create price classes first.');
      }

      const byLevel = new Map<number, PriceClassRow>();
      const byPriceIndex = new Map<number, PriceClassRow>();
      for (const row of priceClassRows) {
        if (!byLevel.has(row.level)) byLevel.set(row.level, row);
        if (
          row.priceIndex != null &&
          Number.isInteger(row.priceIndex) &&
          !byPriceIndex.has(row.priceIndex)
        ) {
          byPriceIndex.set(row.priceIndex, row);
        }
      }
      const ordered = [...priceClassRows].sort((a, b) => {
        const ai = a.priceIndex != null && Number.isInteger(a.priceIndex) ? a.priceIndex : 1_000_000;
        const bi = b.priceIndex != null && Number.isInteger(b.priceIndex) ? b.priceIndex : 1_000_000;
        if (ai !== bi) return ai - bi;
        return a.level - b.level;
      });
      const priceClassMaps: PriceClassMaps = { byLevel, byPriceIndex, ordered };

      const existingDepthOptions = (await strapi.documents(CT_DEPTH_OPTION).findMany({
        fields: ['id', 'documentId', 'name'],
        pagination: { limit: -1 },
      })) as unknown as { id: DocId; documentId: string; name: string }[];
      const depthByName = new Map<string, { id: DocId; documentId: string; name: string }>();
      for (const d of existingDepthOptions) {
        const key = (d.name || '').trim();
        if (key && !depthByName.has(key)) depthByName.set(key, d);
      }

      const existingSurcharges = (await strapi.documents(CT_SURCHARGE).findMany({
        fields: ['id', 'documentId', 'name', 'code'],
        pagination: { limit: -1 },
      })) as unknown as { id: DocId; documentId: string; name: string; code: string }[];
      const surchargeByCode = new Map<
        string,
        { id: DocId; documentId: string; name: string; code: string }
      >();
      for (const s of existingSurcharges) {
        const key = (s.code || '').trim();
        if (key && !surchargeByCode.has(key)) surchargeByCode.set(key, s);
      }

      const hasLeftRight = product.width.some((w) => w.LR === true);

      const cabinetTypeData: Record<string, unknown> = {
        name: cabinetTypeNameFromProduct(product),
        description:
          typeof product.description === 'string' ? product.description.trim() || null : null,
        hasLeftRight,
        cabinetSeries: cabinetSeriesDocumentId,
      };
      if (imageId !== undefined) cabinetTypeData.image = imageId;

      const cabinetType = await strapi.documents(CT_CABINET_TYPE).create({
        data: cabinetTypeData as any,
      });
      await strapi
        .documents(CT_CABINET_TYPE)
        .publish({ documentId: cabinetType.documentId });

      const cabinetTypeDocumentId = cabinetType.documentId;
      const cabinetTypeNumericId = cabinetType.id;

      const variantsCreated: { orderNumber: string; documentId: string }[] = [];
      let createdVariantPriceCount = 0;
      let skippedPricesMissingPriceClass = 0;

      for (const w of product.width) {
        const orderNumber = typeof w.code === 'string' ? w.code.trim() : '';
        if (!orderNumber) continue;

        const variable = w.value == null && w.min != null && w.max != null;
        const widthMm = w.value != null ? w.value : w.min != null ? w.min : 1;

        const variantData: Record<string, unknown> = {
          orderNumber,
          width: widthMm,
          isVariableWidth: variable,
          minWidth: variable ? w.min : null,
          maxWidth: variable ? w.max : null,
          cabinetType: cabinetTypeDocumentId,
        };
        if (lockVariantHeight) variantData.height = null;

        const variant = await strapi.documents(CT_CABINET_VARIANT).create({
          data: variantData as any,
        });
        await strapi
          .documents(CT_CABINET_VARIANT)
          .publish({ documentId: variant.documentId });

        variantsCreated.push({ orderNumber, documentId: variant.documentId });

        for (const pg of w.priceGroups) {
          const cls = resolvePriceClass(pg.class, priceClassMaps);
          if (!cls) {
            skippedPricesMissingPriceClass += 1;
            continue;
          }
          const cp = await strapi.documents(CT_CABINET_PRICE).create({
            data: {
              price: pg.price,
              cabinetVariant: variant.documentId,
              priceClass: cls.documentId,
            } as any,
          });
          await strapi
            .documents(CT_CABINET_PRICE)
            .publish({ documentId: cp.documentId });
          createdVariantPriceCount += 1;
        }
      }

      const depthResults: { name: string; action: 'linked' | 'created'; documentId: string }[] = [];
      for (const d of product.depthOptions) {
        const nameKey = (d.name || '').trim();
        if (!nameKey) continue;

        const existing = depthByName.get(nameKey);
        if (existing) {
          await strapi.documents(CT_DEPTH_OPTION).update({
            documentId: existing.documentId,
            data: { cabinetTypes: { connect: [cabinetTypeDocumentId] } } as any,
          });
          await strapi
            .documents(CT_DEPTH_OPTION)
            .publish({ documentId: existing.documentId });
          depthResults.push({ name: nameKey, action: 'linked', documentId: existing.documentId });
        } else {
          const created = await strapi.documents(CT_DEPTH_OPTION).create({
            data: {
              name: nameKey,
              depth: d.value,
              isDefault: false,
              cabinetTypes: [cabinetTypeDocumentId],
            } as any,
          });
          await strapi
            .documents(CT_DEPTH_OPTION)
            .publish({ documentId: created.documentId });
          depthResults.push({ name: nameKey, action: 'created', documentId: created.documentId });
          depthByName.set(nameKey, {
            id: created.id,
            documentId: created.documentId,
            name: nameKey,
          });
        }
      }

      const surchargeResults: { name: string; action: 'linked' | 'created'; surchargeId: DocId }[] =
        [];

      for (const s of product.surcharges) {
        const codeKey = typeof s.code === 'string' ? s.code.trim() : '';
        if (!codeKey) continue;

        const nameForCreate = (s.name || '').trim() || codeKey;

        const priceRows = new Map<string, { priceClassDocumentId: string; price: number }>();
        for (const pg of s.priceGroups) {
          const cls = resolvePriceClass(pg.class, priceClassMaps);
          if (!cls) {
            skippedPricesMissingPriceClass += 1;
            continue;
          }
          priceRows.set(cls.documentId, { priceClassDocumentId: cls.documentId, price: pg.price });
        }
        if (priceRows.size === 0) continue;

        let surchargeRow = surchargeByCode.get(codeKey);
        if (!surchargeRow) {
          const created = await strapi.documents(CT_SURCHARGE).create({
            data: {
              name: nameForCreate,
              code: codeKey,
            } as any,
          });
          await strapi
            .documents(CT_SURCHARGE)
            .publish({ documentId: created.documentId });
          surchargeRow = {
            id: created.id,
            documentId: created.documentId,
            name: nameForCreate,
            code: codeKey,
          };
          surchargeByCode.set(codeKey, surchargeRow);
          surchargeResults.push({
            name: surchargeRow.name,
            action: 'created',
            surchargeId: surchargeRow.id,
          });
        } else {
          surchargeResults.push({
            name: surchargeRow.name,
            action: 'linked',
            surchargeId: surchargeRow.id,
          });
        }

        const link = await strapi.documents(CT_SURCHARGE_LINK).create({
          data: {
            cabinetType: cabinetTypeDocumentId,
            surcharge: surchargeRow.documentId,
          } as any,
        });
        await strapi
          .documents(CT_SURCHARGE_LINK)
          .publish({ documentId: link.documentId });

        for (const row of priceRows.values()) {
          const sp = await strapi.documents(CT_SURCHARGE_PRICE).create({
            data: {
              price: row.price,
              link: link.documentId,
              priceClass: row.priceClassDocumentId,
            } as any,
          });
          await strapi
            .documents(CT_SURCHARGE_PRICE)
            .publish({ documentId: sp.documentId });
        }
      }

      return {
        cabinetType: { id: cabinetTypeNumericId, documentId: cabinetTypeDocumentId },
        variants: variantsCreated,
        variantCount: variantsCreated.length,
        cabinetPricesCreated: createdVariantPriceCount,
        skippedPricesMissingPriceClass,
        depthOptions: depthResults,
        surcharges: surchargeResults,
      };
    });
  },
});
