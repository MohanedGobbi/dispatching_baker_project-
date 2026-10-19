import { SetMetadata } from '@nestjs/common';
import type { Level, Module } from './permissions';

export const Public = () => SetMetadata('public', true);
/** Require at least `level` on `module`. Routes without it only need a valid login. */
export const Require = (module: Module, level: Level) => SetMetadata('require', { module, level });
