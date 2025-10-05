import { Getter, Schema } from "effect/schema"
import { BigDecimal as BD, DateTime } from "effect"

export const BigDecimal = Schema.declare(BD.isBigDecimal)

export const BigDecimalFromNumber = Schema.Number.pipe(
  Schema.decodeTo(BigDecimal, {
    decode: Getter.transform(BD.fromNumberUnsafe),
    encode: Getter.transform(BD.toNumberUnsafe),
  }),
)

export const DateTimeZoned = Schema.declare(
  (u) => DateTime.isDateTime(u) && DateTime.isZoned(u),
)

export const DateTimeZonedFromString = Schema.String.pipe(
  Schema.decodeTo(DateTimeZoned, {
    decode: Getter.transform(DateTime.makeZonedUnsafe),
    encode: Getter.transform(DateTime.formatIsoZoned),
  }),
)
