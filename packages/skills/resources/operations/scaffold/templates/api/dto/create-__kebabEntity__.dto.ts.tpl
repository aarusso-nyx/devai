/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/*
 * Template-shaped Create DTO. Fields are rendered from the
 * blueprint entity's `fields[]` (minus audit fields: id,
 * created_at, updated_at, deleted_at, created_by, updated_by).
 * The import header above includes every validator the
 * renderer might emit — adopters can trim the import list to
 * the validators their fields actually use, or leave it and
 * rely on the bundler / linter to drop unused imports.
 *
 * The __DTO_FIELDS_CREATE__ token keeps field rendering bound
 * to the blueprint entity.
 */
export class Create__classEntity__Dto {
  __DTO_FIELDS_CREATE__;
}
