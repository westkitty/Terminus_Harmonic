/**
 * TERRAIN RENDERING — chunked LOD with ring batching
 * ==================================================
 *
 * The sector near-field is a grid of chunks. Chunks at the same Chebyshev ring
 * distance from the player share a level of detail, and every chunk in a ring is
 * merged into a single BufferGeometry. That keeps terrain draw calls at
 * `rings + 1` regardless of view distance.
 *
 * The far-field is a single low-resolution disc so the horizon never pops.
 *
 * All geometry is generated from the deterministic {@link SectorField}; nothing
 * is cached on disk.
 */

import * as THREE from 'three';
import type { SectorField } from './field';

const CHUNK = 160;
const RINGS = 6;
const RING_SEGMENTS = [40, 32, 24, 16, 12, 8];
const FAR_RADIUS = 9000;
const FAR_SEGMENTS = 96;

interface RingBatch {
  mesh: THREE.Mesh;
  tri: number;
}

function ringChunkOffsets(ring: number): [number, number][] {
  const out: [number, number][] = [];
  if (ring === 0) {
    out.push([0, 0]);
    return out;
  }
  for (let dz = -ring; dz <= ring; dz++) {
    for (let dx = -ring; dx <= ring; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) === ring) out.push([dx, dz]);
    }
  }
  return out;
}

/** Build a merged grid geometry covering the given chunk offsets at `segments`. */
function buildRingGeometry(
  field: SectorField,
  offsets: [number, number][],
  segments: number,
  centerX: number,
  centerZ: number,
): { geometry: THREE.BufferGeometry; triangles: number } {
  const step = CHUNK / segments;
  const cols = segments + 1;
  const perChunkVerts = cols * cols;
  const total = perChunkVerts * offsets.length;
  const positions = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const indices = new Uint32Array(offsets.length * segments * segments * 6);
  const c: [number, number, number] = [0, 0, 0];

  let vBase = 0;
  let iBase = 0;
  for (const [ox, oz] of offsets) {
    const bx = centerX + ox * CHUNK;
    const bz = centerZ + oz * CHUNK;
    for (let iz = 0; iz < cols; iz++) {
      for (let ix = 0; ix < cols; ix++) {
        const x = bx + ix * step;
        const z = bz + iz * step;
        const y = field.elevation(x, z);
        const i3 = vBase * 3;
        positions[i3] = x;
        positions[i3 + 1] = y;
        positions[i3 + 2] = z;
        field.color(x, z, c);
        colors[i3] = c[0];
        colors[i3 + 1] = c[1];
        colors[i3 + 2] = c[2];
        vBase++;
      }
    }
    const start = vBase - perChunkVerts;
    for (let iz = 0; iz < segments; iz++) {
      for (let ix = 0; ix < segments; ix++) {
        const a = start + iz * cols + ix;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        indices[iBase++] = a;
        indices[iBase++] = d;
        indices[iBase++] = b;
        indices[iBase++] = b;
        indices[iBase++] = d;
        indices[iBase++] = e;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return { geometry: geo, triangles: (indices.length / 3) | 0 };
}

export class TerrainRenderer {
  readonly group = new THREE.Group();
  private material: THREE.MeshStandardMaterial;
  private rings: RingBatch[] = [];
  private farMesh: THREE.Mesh | null = null;
  private farTriangles = 0;
  private centerX = Number.NaN;
  private centerZ = Number.NaN;
  private dirtyRings = new Set<number>();
  private field: SectorField;
  private disposed = false;

  /** Triangles currently resident (approximate, for the perf overlay). */
  triangles = 0;

  constructor(field: SectorField) {
    this.field = field;
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0.04,
      flatShading: false,
      dithering: true,
    });
    this.group.name = 'terrain';
    for (let r = 0; r < RINGS; r++) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = `terrain-ring-${r}`;
      this.rings.push({ mesh, tri: 0 });
      this.group.add(mesh);
    }
    this.buildFar();
  }

  /** Force a full rebuild (used when the sector is swapped). */
  reset(field: SectorField): void {
    this.field = field;
    this.centerX = Number.NaN;
    this.centerZ = Number.NaN;
    for (let r = 0; r < RINGS; r++) this.dirtyRings.add(r);
    this.buildFar();
  }

  private buildFar(): void {
    if (this.farMesh) {
      this.farMesh.geometry.dispose();
      this.group.remove(this.farMesh);
      this.farMesh = null;
    }
    const seg = FAR_SEGMENTS;
    const cols = seg + 1;
    const positions = new Float32Array(cols * cols * 3);
    const colors = new Float32Array(cols * cols * 3);
    const indices = new Uint32Array(seg * seg * 6);
    const c: [number, number, number] = [0, 0, 0];
    for (let iz = 0; iz < cols; iz++) {
      for (let ix = 0; ix < cols; ix++) {
        const t = ix / seg;
        const u = iz / seg;
        const ang = t * Math.PI * 2;
        const rad = Math.sqrt(u) * FAR_RADIUS;
        const x = Math.cos(ang) * rad;
        const z = Math.sin(ang) * rad;
        const y = this.field.elevation(x, z) * 0.85;
        const i3 = (iz * cols + ix) * 3;
        positions[i3] = x;
        positions[i3 + 1] = y;
        positions[i3 + 2] = z;
        this.field.color(x, z, c);
        colors[i3] = c[0];
        colors[i3 + 1] = c[1];
        colors[i3 + 2] = c[2];
      }
    }
    let iBase = 0;
    for (let iz = 0; iz < seg; iz++) {
      for (let ix = 0; ix < seg; ix++) {
        const a = iz * cols + ix;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        indices[iBase++] = a;
        indices[iBase++] = d;
        indices[iBase++] = b;
        indices[iBase++] = b;
        indices[iBase++] = d;
        indices[iBase++] = e;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'terrain-far';
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.farMesh = mesh;
    this.group.add(mesh);
    this.farTriangles = (indices.length / 3) | 0;
    this.triangles = this.triangles - 0 + this.farTriangles;
  }

  /** Call each frame with the player position in sector-local coordinates. */
  update(x: number, z: number, budget = 1): void {
    if (this.disposed) return;
    const cx = Math.round(x / CHUNK);
    const cz = Math.round(z / CHUNK);
    if (cx !== this.centerX || cz !== this.centerZ) {
      this.centerX = cx;
      this.centerZ = cz;
      for (let r = 0; r < RINGS; r++) this.dirtyRings.add(r);
    }
    if (this.dirtyRings.size === 0) return;
    let built = 0;
    for (const r of [...this.dirtyRings]) {
      if (built >= budget) break;
      this.buildRing(r);
      this.dirtyRings.delete(r);
      built++;
    }
  }

  private buildRing(r: number): void {
    const batch = this.rings[r];
    const offsets = ringChunkOffsets(r);
    const segments = RING_SEGMENTS[Math.min(r, RING_SEGMENTS.length - 1)];
    const { geometry, triangles } = buildRingGeometry(
      this.field,
      offsets,
      segments,
      this.centerX * CHUNK,
      this.centerZ * CHUNK,
    );
    const old = batch.mesh.geometry;
    batch.mesh.geometry = geometry;
    old.dispose();
    this.triangles = this.triangles - batch.tri + triangles;
    batch.tri = triangles;
  }

  /** Mark every ring dirty (terrain parameters changed). */
  invalidate(): void {
    for (let r = 0; r < RINGS; r++) this.dirtyRings.add(r);
  }

  get drawCalls(): number {
    return RINGS + (this.farMesh ? 1 : 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.rings) r.mesh.geometry.dispose();
    this.farMesh?.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}
