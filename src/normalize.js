import { MODELS, FX_TO_EUR, MOTOR_CODES, MILES_TO_KM } from './config.js';

const firstLabel = (labels) => (Array.isArray(labels) && labels.length ? labels[0].label : null);
const labelOf = (obj) => (obj ? firstLabel(obj.labels) : null);

/** Normaliza la variante de motorización a partir del código y/o etiqueta. */
export function motorVariant(modelCode, code, label = '') {
  const known = MOTOR_CODES[modelCode]?.[code];
  if (known) return known;
  const l = label ?? '';
  if (/perfor?mance/i.test(l)) return 'Performance'; // tolera la errata "Perfomance" vista en etiquetas FR
  if (/single|rear motor|standard range|long range single|enkel|einzel|simple|enkelt|yksi/i.test(l)) return 'Single Motor';
  if (/dual|doppel|dobbel|dubbel|double/i.test(l)) return 'Dual Motor';
  return code ? `Desconocido (${code})` : 'Desconocido';
}

function modelMeta(modelCode, displayName) {
  return MODELS[modelCode] ?? { name: displayName ?? `Modelo ${modelCode}`, short: `M${modelCode}`, slug: `polestar-${modelCode}` };
}

function toEur(price, currency) {
  const fx = FX_TO_EUR[currency];
  return price != null && fx ? Math.round(price * fx) : null;
}

const isNappa = (interior) => /nappa|bridge of weir/i.test(interior ?? '');
const isCoupeP4 = (modelCode, modelYear, displayName) =>
  modelCode === '814' && ((modelYear != null && modelYear >= 2027) || /coup/i.test(displayName ?? ''));

// ---------------------------------------------------------------------------
// PRE-OWNED
// ---------------------------------------------------------------------------

function preownedPacks(vd) {
  const out = [];
  const add = (obj, fallback) => {
    if (!obj) return;
    out.push({ name: fallback, code: obj.code ?? null, label: labelOf(obj) });
  };
  add(vd.pilotPackage, 'Pilot');
  add(vd.plusPackage, 'Plus');
  add(vd.performancePackage, 'Performance');
  add(vd.proPack, 'Pro');
  add(vd.plusProPackage, 'Plus Pro');
  add(vd.climatePack, 'Climate');
  return out;
}

/** Convierte un vehicleAd crudo de la API pre-owned en el registro plano que consume el frontend. */
export function normalizeVehicle(raw, market) {
  const vd = raw.vehicleDetails ?? {};
  const md = vd.modelDetails ?? {};
  const modelCode = String(md.code ?? vd.pno34?.slice(0, 3) ?? '');
  const model = modelMeta(modelCode, md.displayName);

  const currency = raw.price?.currency ?? market.currency;
  const price = raw.price?.retail ?? null;

  const distance = raw.mileageInfo?.distance ?? null;
  const metric = raw.mileageInfo?.metric ?? 'km';
  const mileageKm = distance == null ? null : metric === 'mi' ? Math.round(distance * MILES_TO_KM) : Math.round(distance);

  const variant = motorVariant(modelCode, vd.motorInfo?.value ?? null, firstLabel(vd.motorInfo?.labels));
  const packList = preownedPacks(vd);
  const packNames = packList.map((p) => p.name);
  const interior = labelOf(vd.interior);
  if (isNappa(interior) && !packNames.includes('Nappa')) packNames.push('Nappa');

  const modelYear = md.modelYear ?? null;
  const displayName = md.displayName ?? model.name;

  const studio = (vd.vehicleImages ?? []).find((i) => i.imageType === 'studio') ?? (vd.vehicleImages ?? [])[0];
  const photo = (raw.media ?? []).find((m) => m.mediaType === 'Image');

  return {
    source: 'preowned',
    id: raw.id,
    vin: vd.vin ?? null,
    url: `https://www.polestar.com/${market.slug}/preowned-cars/product/${model.slug}/${raw.id}/`,
    model: model.name,
    modelShort: model.short,
    modelCode,
    displayName,
    modelYear,
    variant,
    motorCode: vd.motorInfo?.value ?? null,
    motorLabel: firstLabel(vd.motorInfo?.labels),
    firstRegistration: raw.firstTimeRegistration ?? null,
    delivery: null,
    mileageKm,
    mileageRaw: distance,
    mileageUnit: metric,
    price,
    listPrice: null,
    discount: 0,
    currency,
    priceEur: toEur(price, currency),
    vatDeductible: raw.vatDeductible ?? null,
    color: labelOf(vd.exterior),
    colorCode: vd.exterior?.code ?? null,
    interior,
    wheels: labelOf(vd.wheels),
    packs: packNames,
    packDetails: packList,
    options: (vd.singleOptions ?? []).map((o) => labelOf(o)).filter(Boolean),
    drivetrain: firstLabel(vd.drivetrainInfo),
    rangeKm: vd.rangeInformation?.[0]?.value ?? null,
    power: firstLabel(vd.engineDetails?.powerInfo),
    acceleration: firstLabel(vd.engineDetails?.accelerationInfo),
    location: raw.handoverLocation ? `${raw.handoverLocation.name ?? ''}${raw.handoverLocation.city ? ' · ' + raw.handoverLocation.city : ''}`.trim() : null,
    locationCity: raw.handoverLocation?.city ?? raw.partnerLocation?.city ?? null,
    partner: raw.partnerLocation?.name ?? null,
    country: market.api,
    countryName: market.name,
    countryFlag: market.flag,
    marketSlug: market.slug,
    eu: market.eu,
    rhd: market.rhd,
    flags: {
      coupe: isCoupeP4(modelCode, modelYear, displayName),
      single: variant === 'Single Motor',
      nonEu: !market.eu,
      rhd: market.rhd,
      campaign: false,
    },
    cycleState: vd.cycleState ?? null,
    versionTimestamp: raw.versionTimestamp ?? null,
    imageStudio: studio?.url ?? null,
    imagePhoto: photo?.data ?? null,
    pno34: vd.pno34 ?? null,
    structureWeek: md.structureWeek ?? null,
  };
}

// ---------------------------------------------------------------------------
// STOCK CARS (coches nuevos listos para entrega)
// ---------------------------------------------------------------------------

const contentOf = (car, type) => (car.content ?? []).filter((c) => c.featureType === type);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : null);

/** Convierte un registro de filteredStockCars en el mismo formato plano que los pre-owned. */
export function normalizeStockCar(car, market) {
  const modelCode = String(contentOf(car, 'Model')[0]?.code ?? car.pno34?.slice(0, 3) ?? '');
  const displayName = contentOf(car, 'Model')[0]?.name ?? null;
  const model = modelMeta(modelCode, displayName);
  const modelYear = num(car.modelYear);

  const engine = contentOf(car, 'Engine')[0];
  const variant = motorVariant(modelCode, engine?.code ?? null, engine?.name ?? car.techData?.driveTrain ?? '');

  const cp = car.cashPriceData ?? {};
  const listPrice = num(cp.listPrice?.totals?.car?.carTotalPrice?.value);
  const discounted = num(cp.discounted?.totals?.car?.carTotalPrice?.value);
  const price = discounted != null && listPrice != null ? Math.min(discounted, listPrice) : (discounted ?? listPrice);
  const discount = listPrice != null && price != null && listPrice > price ? Math.round(listPrice - price) : 0;
  const currency = market.currency;

  const packNames = [];
  for (const p of car.packages ?? []) if (p?.name && !packNames.includes(p.name)) packNames.push(p.name);
  for (const p of contentOf(car, 'Packages')) if (p?.name && !packNames.includes(p.name)) packNames.push(p.name);
  const bundles = (car.bundles ?? []).map((b) => b.name).filter(Boolean);
  const interior = contentOf(car, 'Upholstery')[0]?.name ?? null;
  if (isNappa(interior) && !packNames.includes('Nappa')) packNames.push('Nappa');

  const views = car.carVisualizationImages?.views ?? [];
  const summary = views.find((v) => v.name === 'summary') ?? views[0];
  const image = summary?.angles?.find((a) => String(a.angle) === '0')?.url ?? summary?.angles?.[0]?.url ?? null;

  const structureWeek = car.startStructureWeek ?? null;
  const url = `https://www.polestar.com/${market.slug}/stock-cars/${model.slug}/${encodeURIComponent(car.pno34 ?? '')}/?year=${modelYear ?? ''}&structureweek=${structureWeek ?? ''}`;

  const wltp = car.wltpNedcSummary?.items ?? [];
  const rangeFromTech = (car.techData?.engineBev_ElectricRange ?? '').replace(/[^0-9]/g, '');
  const range = wltp.find((i) => /range/i.test(i.name))?.value ?? (rangeFromTech || null);

  return {
    source: 'stock',
    id: `stock:${market.slug}:${car.id ?? `${car.pno34}-${modelYear}-${structureWeek}`}`,
    vin: null,
    url,
    model: model.name,
    modelShort: model.short,
    modelCode,
    displayName: displayName ?? model.name,
    modelYear,
    variant,
    motorCode: engine?.code ?? null,
    motorLabel: engine?.name ?? car.techData?.driveTrain ?? null,
    firstRegistration: null,
    delivery: car.earliestDeliveryDateLabel ?? car.stockTypeDeliveryDateLabel ?? null,
    deliveryDate: car.earliestDeliveryDate ?? null,
    mileageKm: 0,
    mileageRaw: 0,
    mileageUnit: 'km',
    price,
    listPrice,
    discount,
    discountPct: discount && listPrice ? Math.round((discount / listPrice) * 1000) / 10 : 0,
    currency,
    priceEur: toEur(price, currency),
    listPriceEur: toEur(listPrice, currency),
    vatDeductible: null,
    color: contentOf(car, 'Color')[0]?.name ?? null,
    colorCode: contentOf(car, 'Color')[0]?.code ?? null,
    interior,
    wheels: contentOf(car, 'Rims')[0]?.name ?? null,
    packs: packNames,
    bundles,
    packDetails: (car.packages ?? []).map((p) => ({ name: p.name, code: p.code, label: p.name })),
    options: contentOf(car, 'Option').map((o) => o.name).filter(Boolean),
    drivetrain: contentOf(car, 'Drive')[0]?.name ?? car.techData?.drive ?? null,
    rangeKm: range || null,
    power: car.techData ? [car.techData.engineBev_TotalKw, car.techData.engineBev_TotalHp].filter(Boolean).join(' / ') || null : null,
    acceleration: car.techData?.performance ?? null,
    location: null,
    locationCity: null,
    partner: null,
    country: market.api,
    countryName: market.name,
    countryFlag: market.flag,
    marketSlug: market.slug,
    eu: market.eu,
    rhd: market.rhd,
    flags: {
      coupe: isCoupeP4(modelCode, modelYear, displayName),
      single: variant === 'Single Motor',
      nonEu: !market.eu,
      rhd: market.rhd,
      campaign: !!car.isCampaignEnabled && discount > 0,
    },
    cycleState: 'New',
    versionTimestamp: null,
    imageStudio: image,
    imagePhoto: null,
    pno34: car.pno34 ?? null,
    structureWeek,
  };
}
