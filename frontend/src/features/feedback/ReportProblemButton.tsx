import { useState } from "react";
import ReportProblemModal from "./ReportProblemModal";

export default function ReportProblemButton({ serviceFailure = false, className }: {
  serviceFailure?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={className} onClick={() => setOpen(true)}>Report problem</button>
    {open && <ReportProblemModal serviceFailure={serviceFailure} onClose={() => setOpen(false)} />}
  </>;
}
