# Project Instructions

## Core Principles

- **No Build Tools**: Use native ES modules and modern browser features
- **Spectacle-First**: Leverage built-in theming and component props
- **Clean Code**: Write maintainable, readable code with minimal complexity

## Spectacle Guidelines

- **NO extra styling** - Use component props instead of `style` attributes
- **Theme-first approach** - Use `color="primary"` not `style={{ color: theme.colors.primary }}`
- **HTM templates** - Always use `htm` with template literals, never JSX
- **Minimal props** - Only specify necessary layout properties

## Code Style

- Use ES6+ features (const/let, arrow functions, destructuring)
- Follow consistent naming conventions (camelCase, PascalCase)
- Keep functions small and focused
- Use semantic HTML and meaningful class names

## File Organization

- Group related files in logical directories
- Use descriptive file names with kebab-case
- Separate concerns (presentation, data, utilities)
- Keep modules focused and cohesive

For detailed guidelines, see `.cursor/rules/` directory.
