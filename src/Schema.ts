import { Getter, Schema } from "effect/schema"
import { BigDecimal as BD } from "effect"

export const BigDecimal = Schema.declare(BD.isBigDecimal)

export const BigDecimalFromNumber: Schema.decodeTo<
  Schema.declare<BD.BigDecimal, BD.BigDecimal>,
  Schema.Number,
  never,
  never
> = Schema.Number.pipe(
  Schema.decodeTo(BigDecimal, {
    decode: Getter.transform(BD.fromNumberUnsafe),
    encode: Getter.transform(BD.toNumberUnsafe),
  }),
)
