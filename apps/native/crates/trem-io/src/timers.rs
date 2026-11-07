//! setTimeout and setInterval for an app's main loop. Each fires a task, of the app's own
//! type; the event loop sleeps until the earliest deadline, so an idle app wakes only for
//! what is due.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::time::Duration;
use web_time::Instant;

pub type TimerId = u64;

struct Item<T> {
    task: T,
    every: Option<Duration>,
    due: Instant,
}

pub struct Timers<T> {
    heap: BinaryHeap<Reverse<(Instant, TimerId)>>,
    items: HashMap<TimerId, Item<T>>,
    next: TimerId,
    /// A test's clock: time moves only when the test says. The `testing` feature has it
    /// for an app's tests, which `cfg(test)` here would not reach.
    #[cfg(any(test, feature = "testing"))]
    pub virtual_now: Option<Instant>,
}

impl<T> Default for Timers<T> {
    fn default() -> Self {
        Self {
            heap: BinaryHeap::new(),
            items: HashMap::new(),
            next: 0,
            #[cfg(any(test, feature = "testing"))]
            virtual_now: None,
        }
    }
}

impl<T: Clone> Timers<T> {
    /// Now, as the timers count it.
    pub fn now(&self) -> Instant {
        #[cfg(any(test, feature = "testing"))]
        if let Some(now) = self.virtual_now {
            return now;
        }
        Instant::now()
    }

    pub fn timeout(&mut self, ms: f64, task: T) -> TimerId {
        self.add(ms, task, false)
    }

    pub fn interval(&mut self, ms: f64, task: T) -> TimerId {
        self.add(ms, task, true)
    }

    fn add(&mut self, ms: f64, task: T, repeat: bool) -> TimerId {
        let wait = Duration::from_secs_f64(ms.max(0.0) / 1000.0);
        let id = self.next;
        self.next += 1;
        let due = self.now() + wait;
        self.items.insert(
            id,
            Item {
                task,
                every: repeat.then_some(wait),
                due,
            },
        );
        self.heap.push(Reverse((due, id)));
        id
    }

    pub fn clear(&mut self, id: TimerId) {
        self.items.remove(&id);
    }

    /// Clear what `slot` holds, leaving it empty.
    pub fn clear_slot(&mut self, slot: &mut Option<TimerId>) {
        if let Some(id) = slot.take() {
            self.clear(id);
        }
    }

    /// The earliest deadline still wanted.
    pub fn next_deadline(&mut self) -> Option<Instant> {
        while let Some(Reverse((due, id))) = self.heap.peek().copied() {
            if self.items.get(&id).is_some_and(|item| item.due == due) {
                return Some(due);
            }
            self.heap.pop();
        }
        None
    }

    /// The next task due by `now`. An interval is rescheduled from `now`, so a machine
    /// that slept runs it once rather than catching up.
    pub fn pop_due(&mut self, now: Instant) -> Option<(TimerId, T)> {
        loop {
            let Reverse((due, id)) = self.heap.peek().copied()?;
            if due > now {
                return None;
            }
            self.heap.pop();
            let Some(item) = self.items.get_mut(&id) else {
                continue;
            };
            if item.due != due {
                continue;
            }
            let task = item.task.clone();
            if let Some(every) = item.every {
                let next = now + every;
                item.due = next;
                self.heap.push(Reverse((next, id)));
            } else {
                self.items.remove(&id);
            }
            return Some((id, task));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    enum Task {
        FocusTick,
        EewWaves,
        LoopBeat,
    }

    #[test]
    fn a_timeout_fires_once_and_a_cleared_one_never() {
        let mut timers = Timers::default();
        let a = timers.timeout(0.0, Task::FocusTick);
        let b = timers.timeout(0.0, Task::EewWaves);
        timers.clear(b);
        let later = Instant::now() + Duration::from_millis(5);
        assert_eq!(timers.pop_due(later), Some((a, Task::FocusTick)));
        assert_eq!(timers.pop_due(later), None);
        assert_eq!(timers.next_deadline(), None);
    }

    #[test]
    fn an_interval_reschedules_from_now_without_catching_up() {
        let mut timers = Timers::default();
        let id = timers.interval(10.0, Task::LoopBeat);
        let later = Instant::now() + Duration::from_secs(5);
        assert_eq!(timers.pop_due(later), Some((id, Task::LoopBeat)));
        assert_eq!(timers.pop_due(later), None);
        assert!(timers.next_deadline().is_some_and(|d| d > later));
    }
}
