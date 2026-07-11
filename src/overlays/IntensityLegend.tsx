import { INTENSITY_LIST } from "@/lib/constants";

/** Left-side vertical intensity color scale (ports the intensity-color-list). */
export function IntensityLegend() {
  return (
    <div className="pointer-events-none absolute bottom-10 left-0 z-10 flex w-[45px] flex-col items-end">
      {/* column-reverse: intensity 1 at the bottom, level 7 at the top */}
      <ul className="flex h-[210px] flex-col-reverse">
        {INTENSITY_LIST.map((label, i) =>
          i === 0 ? null : (
            <li
              key={i}
              className="relative flex h-full items-start ml-[30px] pl-[18px] text-[13px]"
              style={{ color: "#ffffff91" }}
            >
              {/* continuous vertical gradient strip */}
              <span
                className="absolute left-[-10px] top-[8px] box-content h-full w-[10px]"
                style={{
                  background: `linear-gradient(var(--intensity-${i}), var(--intensity-${i - 1}))`,
                  borderLeft: "1px solid #2b2b2b",
                  borderRight: "1px solid #2b2b2b",
                  borderTop: i === 9 ? "1px solid #2b2b2b" : undefined,
                  borderBottom: i === 1 ? "1px solid #2b2b2b" : undefined,
                }}
              >
                {/* boundary tick mark (.color::after) */}
                <span
                  className="absolute top-0 right-[-6px] h-px w-[5px]"
                  style={{ backgroundColor: "#ffffff91" }}
                />
              </span>
              {label}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
