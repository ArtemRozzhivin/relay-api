import { SetMetadata } from '@nestjs/common';

export const NO_ENVELOPE_KEY = 'noEnvelope';
export const NoEnvelope = () => SetMetadata(NO_ENVELOPE_KEY, true);
