const paths: Record<string, string> = {
  fashion: "M9 3l3 2 3-2 2 3-2 2v11H7V8L5 6l2-3z",
  beauty: "M12 3c1.5 0 2.5 1 2.5 2.5S13.5 8 12 8s-2.5-1-2.5-2.5S10.5 3 12 3zM8 9h8l1 11H7L8 9z",
  home: "M4 11l8-6 8 6v9a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1v-9z",
  electronics: "M5 4h14a1 1 0 011 1v11a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM9 20h6M4 8h16",
  food: "M6 3v7a3 3 0 006 0V3M8 3v6M6 3v6M18 3c-2 1-3 3-3 6s1 4 3 4v8",
  wellness: "M12 21s-7-4.5-7-10a5 5 0 019-3 5 5 0 019 3c0 5.5-7 10-7 10-1 0-2-1-4-0z M12 4v14",
  jewelry: "M12 2l3 4H9l3-4zM4 8h16l-8 13L4 8z",
  sports: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18",
  toys: "M8 8a3 3 0 116 0c0 2-3 3-3 5M12 8a3 3 0 116 0c0 2-3 3-3 5M11 13h2v8h-2z",
  pets: "M6 9a2 2 0 100-4 2 2 0 000 4zM18 9a2 2 0 100-4 2 2 0 000 4zM9 6a2 2 0 100-4 2 2 0 000 4zM15 6a2 2 0 100-4 2 2 0 000 4zM12 12c-4 0-6 2.5-6 5a3 3 0 003 3h6a3 3 0 003-3c0-2.5-2-5-6-5z",
};

export function IndustryIcon({ icon, className = "h-5 w-5" }: { icon: string; className?: string }) {
  const d = paths[icon] ?? paths.home;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
