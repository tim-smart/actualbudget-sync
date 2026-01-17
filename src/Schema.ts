import { BigDecimal as BD, Schema, SchemaGetter } from "effect"

export const BigDecimal = Schema.declare(BD.isBigDecimal)

export const BigDecimalFromNumber: Schema.decodeTo<
  Schema.declare<BD.BigDecimal, BD.BigDecimal>,
  Schema.Number,
  never,
  never
> = Schema.Number.pipe(
  Schema.decodeTo(BigDecimal, {
    decode: SchemaGetter.transform(BD.fromNumberUnsafe),
    encode: SchemaGetter.transform(BD.toNumberUnsafe),
  }),
)
