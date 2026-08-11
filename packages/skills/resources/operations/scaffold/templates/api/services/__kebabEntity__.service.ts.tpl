/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { Injectable, NotFoundException } from '@nestjs/common';
import { __classEntity__ } from '../entities/__kebabEntity__.entity';
import { Create__classEntity__Dto } from '../dto/create-__kebabEntity__.dto';
import { Update__classEntity__Dto } from '../dto/update-__kebabEntity__.dto';

/*
 * Template-shaped service: backed by an in-memory Map so the
 * scaffolded module compiles + runs end-to-end without a database.
 * Adopters wire their preferred data layer (TypeORM, stynx-data,
 * Drizzle, raw pg, etc.) by replacing the constructor body and
 * the four methods. The scaffolder is deterministic and the
 * output is template-shaped, not production-ready.
 */
@Injectable()
export class __classEntity__Service {
  private readonly store = new Map<string, __classEntity__>();

  findAll(): __classEntity__[] {
    return Array.from(this.store.values()).sort((a, b) => {
      // Sort by `created_at` desc if the field exists; otherwise
      // preserve insertion order.
      const ac = (a as { created_at?: string }).created_at;
      const bc = (b as { created_at?: string }).created_at;
      if (ac === undefined || bc === undefined) return 0;
      return ac < bc ? 1 : ac > bc ? -1 : 0;
    });
  }

  findOne(id: string): __classEntity__ {
    const entity = this.store.get(id);
    if (entity === undefined) {
      throw new NotFoundException(`__classEntity__ ${id} not found`);
    }
    return entity;
  }

  create(dto: Create__classEntity__Dto): __classEntity__ {
    // Adopter-side TODO: generate the id via the canonical strategy
    // (gen_random_uuid() at the DB, or a host-side helper).
    const cryptoApi = (globalThis as { crypto?: { randomUUID: () => string } }).crypto;
    const id =
      cryptoApi !== undefined
        ? cryptoApi.randomUUID()
        : `__kebabEntity__-${String(this.store.size + 1).padStart(8, '0')}`;
    const now = new Date().toISOString();
    const entity = { id, created_at: now, ...dto } as __classEntity__;
    this.store.set(id, entity);
    return entity;
  }

  update(id: string, dto: Update__classEntity__Dto): __classEntity__ {
    const existing = this.findOne(id);
    const updated = { ...existing, ...dto, id } as __classEntity__;
    this.store.set(id, updated);
    return updated;
  }

  remove(id: string): void {
    if (!this.store.delete(id)) {
      throw new NotFoundException(`__classEntity__ ${id} not found`);
    }
  }
}
