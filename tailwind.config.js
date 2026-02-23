/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./_includes/**/*.{html,md}",
    "./_layouts/**/*.{html,md}",
    "./_posts/**/*.{html,md,markdown}",
    "./*.{html,md}",
    "./about/**/*.{html,md}",
    "./contact/**/*.{html,md}",
    "./blog/**/*.{html,md}"
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#E6C200",
          hover: "#CCA800",
          light: "#FFE033"
        },
        charcoal: "#171717",
        accent: {
          DEFAULT: "#2563EB",
          hover: "#1D4ED8",
          light: "#3B82F6"
        },
        offwhite: "#FAFAFA"
      },
      fontFamily: {
        heading: ['"Roboto Condensed"', "system-ui", "sans-serif"],
        body: ['"Inter"', "system-ui", "sans-serif"]
      },
      borderRadius: {
        '4xl': '2rem'
      }
    }
  },
  plugins: [
    require('@tailwindcss/typography')
  ]
};
