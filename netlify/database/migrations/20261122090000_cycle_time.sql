-- Production master: time to make one piece, in seconds. With the plan's quantities it gives
-- the working hours needed; the material per piece (product_bom) gives the RM / BOP needed.
ALTER TABLE products ADD COLUMN cycle_time DOUBLE PRECISION;
