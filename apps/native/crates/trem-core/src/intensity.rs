//! Intensity levels: a measured intensity's CWA level (domain/utils.ts) and the shake
//! level of a frame of stations (features/rts/shakeLevel.ts).

use std::collections::HashMap;

/// `Math.round`: halves go up.
pub fn js_round(n: f64) -> f64 {
    (n + 0.5).floor()
}

/// CWA level for a measured intensity: rounded below 4.5, then one level per half
/// step, and 7 from 6.5. NaN gives 9, as the chain of comparisons this replaced did.
pub fn intensity_float_to_int(float: f64) -> i32 {
    if float < 0.0 {
        0
    } else if float < 4.5 {
        js_round(float) as i32
    } else if float < 6.5 {
        (float * 2.0).floor() as i32 - 4
    } else {
        9
    }
}

/// rts-image-go's ShakeLevel: stations binned into a 0.05° grid, each cell's strongest
/// intensity above 0 adding (I)^1.5, the sum scaled by 1.4.
pub fn shake_level(points: impl Iterator<Item = (f64, f64, f64)>) -> i32 {
    const CELL: f64 = 0.05;
    let mut grid: HashMap<i64, f64> = HashMap::new();
    for (lon, lat, i) in points {
        if i.is_nan() {
            continue;
        }
        let key = (lon / CELL).floor() as i64 * 100_000 + (lat / CELL).floor() as i64;
        let cell = grid.entry(key).or_insert(i);
        if i > *cell {
            *cell = i;
        }
    }
    let sum: f64 = grid
        .values()
        .filter(|i| **i > 0.0)
        .map(|i| i.powf(1.5))
        .sum();
    js_round(1.4 * sum) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_split_on_their_bounds() {
        assert_eq!(intensity_float_to_int(-0.3), 0);
        assert_eq!(intensity_float_to_int(0.49), 0);
        assert_eq!(intensity_float_to_int(0.5), 1);
        assert_eq!(intensity_float_to_int(4.49), 4);
        assert_eq!(intensity_float_to_int(4.5), 5);
        assert_eq!(intensity_float_to_int(5.0), 6);
        assert_eq!(intensity_float_to_int(5.5), 7);
        assert_eq!(intensity_float_to_int(6.0), 8);
        assert_eq!(intensity_float_to_int(6.5), 9);
        assert_eq!(intensity_float_to_int(f64::NAN), 9);
    }

    #[test]
    fn shake_scores_each_cell_once() {
        let two_in_one_cell = shake_level([(121.01, 23.01, 4.0), (121.02, 23.02, 3.0)].into_iter());
        assert_eq!(two_in_one_cell, 11);
        assert_eq!(shake_level([(121.0, 23.0, -1.0)].into_iter()), 0);
    }
}
